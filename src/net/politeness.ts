import { safeUrl } from "../url.js";

/**
 * Spec §10: identify ourselves with a contact URL. This is aimed at the exact
 * endpoint whose whole purpose is establishing that we behave well
 * (robots.txt, fetched by src/cli.ts's fetchRobots), so it must not be the
 * one anonymous request an operator sees in their logs. The generic (JSON-LD)
 * collector fallback — collect/generic.ts's runGeneric — reuses this same UA,
 * since it also fetches pages directly rather than going through the Bright
 * Data CLI.
 */
export const ROBOTS_UA = "claimrot/0.1 (+https://github.com/claimrot/claimrot)";

/**
 * One in-flight request per host, spaced by minIntervalMs (~0.8 req/s default).
 * Parallelism is ACROSS hosts only. A monitor that hammers 352 hosts is a DDoS
 * with a cron; we have taken a partner's production host down this way before.
 */
/** ~0.8 req/s. The spacing every per-host request is held to, in or out of a queue slot. */
export const MIN_HOST_INTERVAL_MS = 1250;

/** Resolves after `ms`. Used to pace extra requests a single queue slot makes. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HostQueue {
  private tails = new Map<string, Promise<unknown>>();

  constructor(private readonly minIntervalMs = MIN_HOST_INTERVAL_MS) {}

  run<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const parsed = safeUrl(url);
    if (!parsed) {
      // Must reject, not throw synchronously: callers build arrays of run()
      // promises, and a raw throw here would abort array construction and
      // kill scheduling for every other host in the batch.
      return Promise.reject(new TypeError(`Invalid URL: ${url}`));
    }
    const host = parsed.host;
    const prior = this.tails.get(host) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(async () => {
        const started = Date.now();
        try {
          return await fn();
        } finally {
          const wait = this.minIntervalMs - (Date.now() - started);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
      });
    this.tails.set(host, next.catch(() => {}));
    return next as Promise<T>;
  }
}

/**
 * robots.txt check scoped to the wildcard agent group only (`User-agent: *`) —
 * we have no bot name of our own to match a named group, so any group naming
 * a specific agent is not ours to obey or ignore. Absent robots.txt, an empty
 * file, or no wildcard group at all means allowed.
 *
 * Handles `Allow:` as well as `Disallow:`: per the de facto standard (RFC 9309
 * §2.2.2 / Google's documented behaviour), the LONGEST matching rule wins: a
 * targeted `Allow: /private/rates` inside a blanket `Disallow: /private/`
 * carves out an exception. A tie in length favours `Allow` (the less
 * restrictive reading) since both rules describe the same path with equal
 * specificity.
 */
export function isAllowed(robotsTxt: string, path: string): boolean {
  type Rule = { type: "allow" | "disallow"; value: string };
  type Group = { agents: string[]; rules: Rule[] };

  const groups: Group[] = [];
  let current: Group | null = null;

  for (const raw of robotsTxt.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const m = /^([a-zA-Z-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();

    if (key === "user-agent") {
      // A fresh block of User-agent lines (no rules seen yet under `current`)
      // still belongs to the SAME group — only a rule line closes a group.
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value);
    } else if ((key === "disallow" || key === "allow") && current && value !== "") {
      current.rules.push({ type: key, value });
    }
  }

  const rules = groups.filter((g) => g.agents.includes("*")).flatMap((g) => g.rules);

  let best: Rule | null = null;
  for (const rule of rules) {
    if (!path.startsWith(rule.value)) continue;
    if (!best || rule.value.length > best.value.length) { best = rule; continue; }
    if (rule.value.length === best.value.length && rule.type === "allow") best = rule;
  }
  return best === null || best.type === "allow";
}
