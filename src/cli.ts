#!/usr/bin/env node
import { Command } from "commander";
import { globSync } from "node:fs";
import { openDb } from "./db/index.js";
import { readFactPack } from "./ingest/factpack.js";
import { normalizeClaim } from "./ingest/normalize.js";
import { resolveCollector } from "./collect/registry.js";
import { runCollector, healCollector, flagBlobCandidates } from "./collect/studio.js";
import { checkAssertion } from "./engine/check.js";
import type { EngineDeps } from "./engine/check.js";
import { nextCheckAt } from "./engine/schedule.js";
import { HostQueue } from "./net/politeness.js";
import { renderReceipts } from "./report/receipts.js";
import { halfLife } from "./report/study.js";
import type { Candidate, Claim, Verdict } from "./model/types.js";
import type { CollectRunResult } from "./collect/types.js";

export function buildProgram(): Command {
  const program = new Command("claimrot");
  program.option("--db <path>", "sqlite path", "claimrot.db");

  program.command("ingest").argument("<glob>", "fact-pack glob")
    .action(async (pattern: string) => {
      const db = openDb(program.opts().db);
      const insClaim = db.prepare(
        `INSERT OR REPLACE INTO claims
         (id,document_id,text,source_url,ingested_at,checked_at,volatile,expires_at,status)
         VALUES (@id,@documentId,@text,@sourceUrl,@ingestedAt,@checkedAt,@volatile,@expiresAt,@status)`);
      const insAssertion = db.prepare(
        `INSERT OR REPLACE INTO assertions
         (id,claim_id,field,op,value_num,value_text,value_max,unit,tolerance,anchor_label,anchor_context,anchor_path)
         VALUES (@id,@claimId,@field,@op,@valueNum,@valueText,@valueMax,@unit,@tolerance,@anchorLabel,@anchorContext,@anchorPath)`);

      for (const file of globSync(pattern)) {
        for (const claim of readFactPack(file)) {
          const assertions = await normalizeClaim(claim.text, claim.id);
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

      // Every active assertion sharing a source_url, so a collector run for that
      // URL can be screened against the FULL anchor set (flagBlobCandidates needs
      // more than the one assertion checkAssertion sees at a time).
      const anchorsForUrl = (url: string): string[] =>
        (db.prepare(
          `SELECT DISTINCT a.anchor_label FROM assertions a
           JOIN claims c ON c.id = a.claim_id
           WHERE c.source_url = ? AND c.status = 'active'`,
        ).all(url) as any[]).map((r) => r.anchor_label).filter(Boolean);

      const verdictHistoryFor = (claimId: string): { verdict: Verdict }[] =>
        db.prepare(
          `SELECT verdict FROM verdicts WHERE claim_id = ? ORDER BY created_at DESC`,
        ).all(claimId) as { verdict: Verdict }[];

      const claimRows = db.prepare(`SELECT * FROM claims WHERE status = 'active'`).all() as any[];

      // --all bypasses the scheduler entirely; otherwise a claim is due only once
      // nextCheckAt's computed date (from its last-known-good reference point and
      // its own verdict history) has arrived.
      const dueClaimIds = new Set<string>();
      for (const c of claimRows) {
        if (opts.all) { dueClaimIds.add(c.id); continue; }

        const history = verdictHistoryFor(c.id);
        const lastVerdict: Verdict | null = history[0]?.verdict ?? null;
        let consecutiveUnverifiable = 0;
        for (const h of history) {
          if (h.verdict !== "UNVERIFIABLE") break;
          consecutiveUnverifiable++;
        }

        const claim: Claim = {
          id: c.id, documentId: c.document_id, text: c.text, sourceUrl: c.source_url,
          ingestedAt: c.ingested_at, checkedAt: c.checked_at, volatile: !!c.volatile,
          expiresAt: c.expires_at, status: c.status,
        };
        // Scheduler reference point: last time CLAIMROT checked (last_checked_at,
        // once it exists), never the immutable source-verification checked_at.
        const reference = new Date(c.last_checked_at || c.checked_at || c.ingested_at);
        const due = Number.isNaN(reference.getTime())
          || nextCheckAt(claim, lastVerdict, consecutiveUnverifiable, reference) <= now;
        if (due) dueClaimIds.add(c.id);
      }

      const rows = db.prepare(
        `SELECT a.*, c.source_url AS sourceUrl FROM assertions a
         JOIN claims c ON c.id = a.claim_id WHERE c.status = 'active'`).all() as any[];
      const dueRows = rows.filter((r) => dueClaimIds.has(r.claim_id));

      const insVerdict = db.prepare(
        `INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at)
         VALUES (?,?,?,?,?,?,?)`);
      // last_checked_at is the scheduler's reference point — without moving it
      // forward a claim that clears the "due" threshold once stays due on every
      // run. checked_at (source verification date) must NEVER be written here:
      // the half-life study measures age against it, so touching it after ingest
      // zeroes every age bucket.
      const updClaimChecked = db.prepare(`UPDATE claims SET last_checked_at = ? WHERE id = ?`);

      // Wraps the plain collector run so every "ok" record is screened through
      // flagBlobCandidates before checkAssertion ever sees it. A field that is
      // emptied entirely by screening reports "empty", which correctly routes to
      // heal rather than a false verdict.
      const wrapRun = (anchors: string[]): EngineDeps["run"] => async (id, url) => {
        const result: CollectRunResult = await runCollector(id, url);
        if (result.status !== "ok") return result;

        const fields: Record<string, Candidate[]> = {};
        for (const [k, v] of Object.entries(result.record.fields)) {
          const kept = flagBlobCandidates(v, anchors);
          if (kept.length > 0) fields[k] = kept;
        }
        const record = { ...result.record, fields };
        return Object.keys(fields).length > 0
          ? { status: "ok" as const, record }
          : { status: "empty" as const, record };
      };

      // One queue.run per row: it wraps the WHOLE checkAssertion call (which may
      // issue up to two collector runs plus a heal), so every network op for a
      // host stays serialized behind that host's slot. Never call runCollector
      // or healCollector outside this.
      await Promise.all(dueRows.map((row) => queue.run(row.sourceUrl, async () => {
        const collectorId = resolveCollector(row.sourceUrl);
        const assertion = {
          id: row.id, claimId: row.claim_id, field: row.field, op: row.op,
          valueNum: row.value_num, valueText: row.value_text, valueMax: row.value_max,
          unit: row.unit, tolerance: row.tolerance, anchorLabel: row.anchor_label,
          anchorContext: row.anchor_context, anchorPath: row.anchor_path,
        };
        const anchors = anchorsForUrl(row.sourceUrl);
        const resolution = await checkAssertion(assertion, collectorId, row.sourceUrl, {
          run: wrapRun(anchors),
          heal: (id, prompt, url) => healCollector(id, prompt, { url, autoApprove: true }),
        });
        const checkedAt = new Date().toISOString();
        insVerdict.run(`${row.id}:${Date.now()}`, "", row.claim_id, resolution.verdict,
          resolution.confidence, JSON.stringify(resolution), checkedAt);
        updClaimChecked.run(checkedAt, row.claim_id);
        console.log(`${resolution.verdict}\t${row.claim_id}\t${resolution.reason}`);
      })));
    });

  program.command("report").option("--verdict <v>", "filter by verdict", "DRIFTED")
    .action((opts) => console.log(renderReceipts(openDb(program.opts().db), opts.verdict)));

  program.command("study")
    .action(() => console.log(JSON.stringify(halfLife(openDb(program.opts().db)), null, 2)));

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) buildProgram().parse();
