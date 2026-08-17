#!/usr/bin/env node
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import type Database from "better-sqlite3";
import { openDb } from "./db/index.js";
import { rowToAssertion, rowToClaim } from "./db/rows.js";
import type { AssertionRow, ClaimRow } from "./db/rows.js";
import {
  INSERT_CLAIM_SQL, INSERT_ASSERTION_SQL, INSERT_VERDICT_SQL, UPDATE_LAST_CHECKED_SQL,
} from "./db/statements.js";
import { readFactPack } from "./ingest/factpack.js";
import { normalizeClaim } from "./ingest/normalize.js";
import { selectBackend } from "./ingest/backends.js";
import { resolveCollector, GENERIC_COLLECTOR_ID, isGenericCollector } from "./collect/registry.js";
import { runCollector, healCollector, withBlobScreening } from "./collect/studio.js";
import { runGeneric } from "./collect/generic.js";
import { discoverSuccessors } from "./collect/successor.js";
import { checkAssertion } from "./engine/check.js";
import type { EngineDeps } from "./engine/check.js";
import { nextCheckAt } from "./engine/schedule.js";
import { HostQueue, isAllowed, ROBOTS_UA, sleep, MIN_HOST_INTERVAL_MS } from "./net/politeness.js";
import { safeUrl } from "./url.js";
import { renderReceipts, renderVerdictsJson } from "./report/receipts.js";
import { halfLife } from "./report/study.js";
import type { Verdict } from "./model/types.js";
type Db = Database.Database;
type Stmt = Database.Statement;

// Re-exported so tests can import these from src/cli.js without caring that
// the underlying definitions live in db/statements.ts, collect/registry.ts and
// collect/generic.ts / net/politeness.ts — cli.ts is the single place that
// wires the whole `check` pipeline together.
export { UPDATE_LAST_CHECKED_SQL };
export { GENERIC_COLLECTOR_ID, isGenericCollector };
export { runGeneric };
export { ROBOTS_UA };

const ROBOTS_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetches robots.txt for a host, identified (ROBOTS_UA) and time-bounded
 * (ROBOTS_FETCH_TIMEOUT_MS — a hung fetch must not stall that host's whole
 * queue). Any failure — timeout, network error, or a non-ok response
 * including 404 — yields "" (allowed): a robots-fetch problem must never
 * read as a silent refusal to check; only an actually-present Disallow does
 * that. `fetchImpl` defaults to global fetch and exists purely so a test can
 * inject a fake, the same pattern collect/studio.ts uses for Exec.
 */
export async function fetchRobots(
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const res = await fetchImpl(`https://${host}/robots.txt`, {
      headers: { "user-agent": ROBOTS_UA },
      signal: AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS),
    });
    return res.ok ? await res.text() : "";
  } catch {
    return "";
  }
}

/**
 * Spec §5 escalation: a claim whose two most recent verdicts are BOTH
 * AMBIGUOUS has read two ways twice running — that's a human's problem, not
 * something the scheduler or the collector can resolve on its own.
 */
export function repeatAmbiguousClaims(db: Db): string[] {
  const rows = db.prepare(
    `SELECT claim_id FROM (
       SELECT claim_id, verdict,
              ROW_NUMBER() OVER (PARTITION BY claim_id ORDER BY created_at DESC) AS rn
       FROM verdicts
     ) WHERE rn <= 2 GROUP BY claim_id
       HAVING COUNT(*) = 2 AND SUM(verdict = 'AMBIGUOUS') = 2`,
  ).all() as { claim_id: string }[];
  return rows.map((r) => r.claim_id);
}

/**
 * Every active claim under `--all`; otherwise only claims whose scheduler
 * reference point (last_checked_at, falling back to checked_at, then
 * ingested_at) has reached nextCheckAt's computed date. A reference point
 * that fails to parse counts as due — an unparseable date must not silently
 * suppress a check forever.
 */
function dueClaimIds(db: Db, all: boolean, now: Date): Set<string> {
  const claimRows = db.prepare(`SELECT * FROM claims WHERE status = 'active'`).all() as ClaimRow[];
  const ids = new Set<string>();

  for (const c of claimRows) {
    if (all) { ids.add(c.id); continue; }

    const history = db.prepare(
      `SELECT verdict FROM verdicts WHERE claim_id = ? ORDER BY created_at DESC`,
    ).all(c.id) as { verdict: Verdict }[];
    const lastVerdict: Verdict | null = history[0]?.verdict ?? null;
    let consecutiveUnverifiable = 0;
    for (const h of history) {
      if (h.verdict !== "UNVERIFIABLE") break;
      consecutiveUnverifiable++;
    }

    const reference = new Date(c.last_checked_at || c.checked_at || c.ingested_at);
    const due = Number.isNaN(reference.getTime())
      || nextCheckAt(rowToClaim(c), lastVerdict, consecutiveUnverifiable, reference) <= now;
    if (due) ids.add(c.id);
  }
  return ids;
}

/**
 * Spec §10: robots.txt is fetched once per host, through the SAME HostQueue
 * that paces every other request to that host — a robots fetch is still a
 * request. This must run as its own top-level Promise.all BEFORE the
 * per-row check loop, never nested inside it: queue.run for a host
 * serializes onto that host's own tail, so a nested call for the same host
 * would wait on a slot that is itself waiting on the nested call — a
 * deadlock.
 */
async function prefetchRobots(hosts: string[], queue: HostQueue): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  await Promise.all(hosts.map((host) => queue.run(`https://${host}/robots.txt`, async () => {
    cache.set(host, await fetchRobots(host));
  })));
  return cache;
}

/**
 * Builds the EngineDeps["run"] for one field: resolves a "generic" collector
 * ID (registry.ts's fallback for the unmatched tail) to a direct fetch +
 * JSON-LD read instead of the Bright Data CLI — there is no Bright Data
 * collector actually named "generic" — then screens every result through
 * withBlobScreening using the full anchor set for the source URL.
 */
function buildWrapRun(field: string, anchors: string[]): EngineDeps["run"] {
  return withBlobScreening(
    (id, url) => (isGenericCollector(id) ? runGeneric(url, field) : runCollector(id, url)),
    anchors,
  );
}

// Every active assertion sharing a source_url, so a collector run for that
// URL can be screened against the FULL anchor set (flagBlobCandidates needs
// more than the one assertion checkAssertion sees at a time).
function anchorsForUrl(db: Db, url: string): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT a.anchor_label FROM assertions a
     JOIN claims c ON c.id = a.claim_id
     WHERE c.source_url = ? AND c.status = 'active'`,
  ).all(url) as { anchor_label: string | null }[];
  return rows.map((r) => r.anchor_label).filter((label): label is string => Boolean(label));
}

type DueAssertionRow = AssertionRow & { sourceUrl: string };

interface CheckContext {
  db: Db;
  robotsCache: Map<string, string>;
  insVerdict: Stmt;
  updClaimChecked: Stmt;
}

/**
 * Runs one due assertion end to end: robots check, collector resolution,
 * checkAssertion (which may issue up to two collector runs plus a heal), and
 * persistence. The WHOLE call is wrapped in queue.run for the row's host, so
 * every network op for that host stays serialized behind its slot — never
 * call runCollector or healCollector outside a queue.run.
 */
function runOneCheck(row: DueAssertionRow, queue: HostQueue, ctx: CheckContext): Promise<void> {
  return queue.run(row.sourceUrl, async () => {
    let host: string | null = null;
    let path = "/";
    const parsed = safeUrl(row.sourceUrl);
    if (parsed) { host = parsed.host; path = parsed.pathname || "/"; }
    // else: malformed URL — let collector resolution fail naturally below.

    // A claim we declined to check gets no verdict at all — inventing one
    // would be exactly the kind of lie this project exists to prevent.
    if (host && !isAllowed(ctx.robotsCache.get(host) ?? "", path)) {
      console.log(`SKIPPED (robots.txt)\t${row.claim_id}\t${row.sourceUrl}`);
      return;
    }

    const collectorId = resolveCollector(row.sourceUrl);
    const assertion = rowToAssertion(row);
    const anchors = anchorsForUrl(ctx.db, row.sourceUrl);
    const robotsTxt = host ? ctx.robotsCache.get(host) ?? "" : "";
    const resolution = await checkAssertion(assertion, collectorId, row.sourceUrl, {
      run: buildWrapRun(row.field, anchors),
      heal: (id, prompt, url) => healCollector(id, prompt, { url, autoApprove: true }),
      // Same host, same queue slot, same robots.txt we already fetched — so
      // relocation cannot outrun the pacing this claim was admitted under.
      // `pace` is what actually holds it to that: HostQueue spaces slots, and
      // relocation adds several requests INSIDE one.
      pace: () => sleep(MIN_HOST_INTERVAL_MS),
      successors: (url, a) => discoverSuccessors(url, a, {
        isAllowedPath: (p) => isAllowed(robotsTxt, p),
        pace: () => sleep(MIN_HOST_INTERVAL_MS),
        onDropped: (n) =>
          console.log(`NOTE\t${row.claim_id}\tsuccessor search capped: ${n} lower-ranked candidate(s) not tried`),
      }),
    });
    const checkedAt = new Date().toISOString();
    ctx.insVerdict.run(`${row.id}:${Date.now()}`, "", row.claim_id, resolution.verdict,
      resolution.confidence, JSON.stringify(resolution), checkedAt);
    ctx.updClaimChecked.run(checkedAt, row.claim_id);
    console.log(`${resolution.verdict}\t${row.claim_id}\t${resolution.reason}`);
  });
}

/**
 * Whether a binary is runnable here. `--version` rather than a PATH scan so a
 * shell function, alias-shim or broken symlink cannot pass as an installed CLI.
 */
function onPath(bin: string): boolean {
  return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
}

export function buildProgram(): Command {
  const program = new Command("claimrot");
  program.option("--db <path>", "sqlite path", "claimrot.db");

  program.command("ingest").argument("<glob>", "fact-pack glob")
    .option("--backend <name>", "api | claude-cli | codex-cli (default: whatever this machine can authenticate)")
    .action(async (pattern: string, opts: { backend?: string }) => {
      const db = openDb(program.opts().db);
      const insClaim = db.prepare(INSERT_CLAIM_SQL);
      const insAssertion = db.prepare(INSERT_ASSERTION_SQL);
      const { name, parse } = selectBackend(opts.backend, process.env, onPath);
      console.log(`ingest backend: ${name}`);

      for (const file of globSync(pattern)) {
        for (const claim of readFactPack(file)) {
          const assertions = await normalizeClaim(claim.text, claim.id, { parse });
          insClaim.run({ ...claim, volatile: claim.volatile ? 1 : 0,
            status: assertions.length ? "active" : "untestable" });
          for (const a of assertions) insAssertion.run(a);
          console.log(`${claim.id}: ${assertions.length} assertion(s)`);
        }
      }
    });

  program.command("check").option("--all", "check every active claim, not just due ones")
    .action(async (opts) => {
      const db = openDb(program.opts().db);
      const queue = new HostQueue();
      const now = new Date();

      const due = dueClaimIds(db, !!opts.all, now);

      const rows = db.prepare(
        `SELECT a.*, c.source_url AS sourceUrl FROM assertions a
         JOIN claims c ON c.id = a.claim_id WHERE c.status = 'active'`).all() as DueAssertionRow[];
      const dueRows = rows.filter((r) => due.has(r.claim_id));

      const insVerdict = db.prepare(INSERT_VERDICT_SQL);
      // last_checked_at is the scheduler's reference point — without moving it
      // forward a claim that clears the "due" threshold once stays due on every
      // run. checked_at (source verification date) must NEVER be written here:
      // the half-life study measures age against it, so touching it after ingest
      // zeroes every age bucket.
      const updClaimChecked = db.prepare(UPDATE_LAST_CHECKED_SQL);

      const hosts = [...new Set(
        dueRows.map((r) => safeUrl(r.sourceUrl)?.host ?? null).filter((h): h is string => h !== null),
      )];
      const robotsCache = await prefetchRobots(hosts, queue);

      const ctx: CheckContext = { db, robotsCache, insVerdict, updClaimChecked };
      await Promise.all(dueRows.map((row) => runOneCheck(row, queue, ctx)));
    });

  program.command("report").option("--verdict <v>", "filter by verdict", "DRIFTED")
    .option("--json", "emit every claim's latest verdict as JSON (for the GitHub Action), ignoring --verdict")
    .action((opts) => {
      const db = openDb(program.opts().db);

      if (opts.json) {
        // Feeds action/main.ts (docs/design.md §8.2) — the whole checked set,
        // not filtered by --verdict, since the action needs HOLDS/UNVERIFIABLE
        // counts too, not just the failing verdicts.
        console.log(JSON.stringify(renderVerdictsJson(db), null, 2));
        return;
      }

      console.log(renderReceipts(db, opts.verdict));

      const repeats = repeatAmbiguousClaims(db);
      if (repeats.length > 0) {
        console.log("\nRepeat-ambiguous (needs a human):");
        for (const id of repeats) console.log(`  ${id}`);
      }
    });

  program.command("study")
    .action(() => console.log(JSON.stringify(halfLife(openDb(program.opts().db)), null, 2)));

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) buildProgram().parse();
