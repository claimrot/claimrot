#!/usr/bin/env node
import { Command, Option } from "commander";
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { fetchRobots } from "./net/robots.js";
import { safeUrl } from "./url.js";
import { renderReceipts, renderVerdictsJson } from "./report/receipts.js";
import { renderDashboard } from "./report/dashboard.js";
import { repeatAmbiguousClaimIds } from "./report/current.js";
import { halfLife } from "./report/study.js";
import type { Verdict } from "./model/types.js";
import {
  monitorIdFor, parseIntervalDays, readExtractionSchema,
} from "./extract/schema.js";
import { executeExtraction } from "./extract/service.js";
import {
  getMonitorSnapshot, listExtractionMonitors, listMonitorSnapshots, upsertExtractionMonitor,
} from "./extract/store.js";
import type { ExtractionOutcome, MonitorSnapshot } from "./extract/types.js";
import { startViewServer } from "./server/view.js";
type Db = Database.Database;
type Stmt = Database.Statement;

// Re-exported so tests can import these from src/cli.js without caring that
// the underlying definitions live in db/statements.ts, collect/registry.ts and
// collect/generic.ts / net/politeness.ts — cli.ts is the single place that
// wires the whole `check` pipeline together.
export { UPDATE_LAST_CHECKED_SQL };
export { GENERIC_COLLECTOR_ID, isGenericCollector };
export { runGeneric };
export { ROBOTS_UA, fetchRobots };

function printExtractionOutcome(result: ExtractionOutcome, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.status}\t${result.monitorId}\t${result.url}`);
  for (const field of Object.values(result.fields)) {
    const value = field.value === null ? "—" : `${field.value}${field.unit ? ` ${field.unit}` : ""}`;
    console.log(`  ${field.field}\t${field.status}\t${value}`);
  }
  if (result.healStatus !== "NOT_NEEDED") console.log(`  heal\t${result.healStatus}`);
  if (result.error) console.log(`  error\t${result.error}`);
}

function printSnapshot(snapshot: MonitorSnapshot): void {
  console.log(`${snapshot.monitor.id}\t${snapshot.latestRun?.status ?? "NOT_RUN"}\t${snapshot.monitor.sourceUrl}`);
  for (const field of Object.values(snapshot.fields)) {
    const value = field.value === null ? "—" : `${field.value}${field.unit ? ` ${field.unit}` : ""}`;
    console.log(`  ${field.field}\t${field.status}\t${value}`);
  }
}

/**
 * Spec §5 escalation: a claim with an assertion whose two most recent
 * verdicts are BOTH AMBIGUOUS has read two ways twice running — that's a
 * human's problem, not something the scheduler can resolve on its own.
 */
export function repeatAmbiguousClaims(db: Db): string[] {
  return repeatAmbiguousClaimIds(db);
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
    ctx.insVerdict.run(`${row.id}:${Date.now()}`, "", row.claim_id, row.id, resolution.verdict,
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

  program.command("extract")
    .description("create or update a structured extraction monitor and run it immediately")
    .argument("<url>", "public source URL")
    .requiredOption("-s, --schema <path>", "JSON extraction schema")
    .option("--id <id>", "stable monitor ID (derived from the URL by default)")
    .option("--interval <days>", "rescan interval in days")
    .option("--json", "emit the extraction result as JSON")
    .action(async (
      url: string,
      opts: { schema: string; id?: string; interval?: string; json?: boolean },
    ) => {
      const parsed = safeUrl(url);
      if (!parsed || !["http:", "https:"].includes(parsed.protocol)
        || parsed.username !== "" || parsed.password !== "") {
        throw new Error(`Only unauthenticated HTTP(S) URLs can be extracted: ${url}`);
      }
      if (parsed.hostname === "api.viator.com") {
        throw new Error("Authenticated partner APIs are outside claimrot's public-data scope");
      }
      const definition = readExtractionSchema(opts.schema);
      const id = opts.id ?? monitorIdFor(parsed.href);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id)) {
        throw new Error("monitor ID must be 1-128 letters, numbers, dots, underscores, colons, or hyphens");
      }
      const intervalDays = opts.interval
        ? parseIntervalDays(opts.interval)
        : definition.intervalDays ?? 90;
      const db = openDb(program.opts().db);
      upsertExtractionMonitor(db, {
        id,
        sourceUrl: parsed.href,
        definition,
        intervalDays,
        collectorId: resolveCollector(parsed.href),
        now: new Date().toISOString(),
      });
      printExtractionOutcome(
        await executeExtraction(db, id, { force: true }),
        Boolean(opts.json),
      );
    });

  program.command("get")
    .description("read the latest persisted extraction result")
    .argument("[id]", "monitor ID; omit to read every monitor")
    .option("--json", "emit stable structured JSON")
    .action((id: string | undefined, opts: { json?: boolean }) => {
      const db = openDb(program.opts().db);
      if (id) {
        const snapshot = getMonitorSnapshot(db, id);
        if (!snapshot) throw new Error(`Unknown extraction monitor: ${id}`);
        if (opts.json) console.log(JSON.stringify(snapshot, null, 2));
        else printSnapshot(snapshot);
        return;
      }
      const snapshots = listMonitorSnapshots(db);
      if (opts.json) console.log(JSON.stringify(snapshots, null, 2));
      else if (snapshots.length) snapshots.forEach(printSnapshot);
      else console.log("No extraction monitors in this database.");
    });

  program.command("run")
    .description("run due extraction monitors")
    .argument("[id]", "one monitor ID; omit to run every due monitor")
    .option("--force", "run even when the monitor is not due")
    .option("--json", "emit results as JSON")
    .action(async (id: string | undefined, opts: { force?: boolean; json?: boolean }) => {
      const db = openDb(program.opts().db);
      const ids = id ? [id] : listExtractionMonitors(db).map((monitor) => monitor.id);
      const results: ExtractionOutcome[] = [];
      // Sequential on purpose: separate monitor executions must not create
      // independent host queues that can burst requests at the same operator.
      for (const monitorId of ids) {
        results.push(await executeExtraction(db, monitorId, { force: Boolean(opts.force) }));
      }
      if (opts.json) console.log(JSON.stringify(id ? results[0] : results, null, 2));
      else if (results.length) results.forEach((result) => printExtractionOutcome(result, false));
      else console.log("No extraction monitors in this database.");
    });

  program.command("test")
    .description("run an extraction without replacing the monitor's current result")
    .argument("<id>", "monitor ID")
    .option("--json", "emit the test result as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const db = openDb(program.opts().db);
      printExtractionOutcome(
        await executeExtraction(db, id, { force: true, dryRun: true }),
        Boolean(opts.json),
      );
    });

  program.command("view")
    .description("serve the local operational dashboard")
    .argument("[database]", "SQLite database path (defaults to --db or ./claimrot.db)")
    .option("-p, --port <port>", "loopback port", "4174")
    .action(async (database: string | undefined, opts: { port: string }) => {
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("port must be a whole number from 1 to 65535");
      }
      const view = await startViewServer(database ?? program.opts().db, { port });
      console.log(`claimrot view: ${view.url}`);
      const stop = () => { void view.close(); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await view.done;
    });

  program.command("ingest").argument("<glob>", "fact-pack glob")
    .option("--backend <name>", "api | claude-cli | codex-cli (default: whatever this machine can authenticate)")
    .action(async (pattern: string, opts: { backend?: string }) => {
      const db = openDb(program.opts().db);
      const insClaim = db.prepare(INSERT_CLAIM_SQL);
      const insAssertion = db.prepare(INSERT_ASSERTION_SQL);
      const insDocument = db.prepare(
        `INSERT INTO documents (id, uri, title) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET uri = excluded.uri, title = excluded.title`,
      );
      const { name, parse } = selectBackend(opts.backend, process.env, onPath);
      console.log(`ingest backend: ${name}`);

      for (const file of globSync(pattern)) {
        for (const claim of readFactPack(file)) {
          insDocument.run(claim.documentId, file, claim.documentId);
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
    .addOption(new Option("--json", "emit every claim's current verdict as JSON (for the GitHub Action), ignoring --verdict").conflicts("html"))
    .addOption(new Option("--html", "emit a self-contained HTML dashboard of every current claim, ignoring --verdict").conflicts("json"))
    .action((opts) => {
      const db = openDb(program.opts().db);
      if (opts.json) {
        // Feeds action/main.ts (docs/design.md §8.2) — the whole checked set,
        // not filtered by --verdict, since the action needs HOLDS/UNVERIFIABLE
        // counts too, not just the failing verdicts.
        console.log(JSON.stringify(renderVerdictsJson(db), null, 2));
        return;
      }
      if (opts.html) {
        console.log(renderDashboard(db));
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  buildProgram().parse();
}
