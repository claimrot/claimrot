// Driver for Task 14's committed example output.
//
// WHY THIS SCRIPT EXISTS (not `claimrot ingest`):
// `ingest` calls the Anthropic-backed prose->assertion normalizer, and this
// machine has no Anthropic API credential. So this script performs the ONE
// step `ingest` would otherwise do — turning a hand-authored assertion into a
// DB row — directly against the schema, using assertions transcribed by hand
// from the real page (verified against docs/probes/2026-08-17-scraper-studio.md
// and a live re-fetch on 2026-08-17). Every step after that is the real,
// unmodified engine: the same `checkAssertion` function `claimrot check` calls,
// against the same live Bright Data Scraper Studio collector created in the
// probe (c_msx2l16bsipcs0zz), followed by the real `claimrot report` CLI.
//
// It intentionally does NOT go through src/cli.ts's `check` command, because
// that command resolves collector IDs via src/collect/registry.ts, whose
// whalewatch.co.nz entry is still the placeholder "c_whalewatch" pending
// collector-ID fill-in (see registry.ts's own comment) — not the real
// Bright Data collector ID this probe actually created. This task's
// concurrency lock forbids editing src/, so this script supplies the real
// collector ID directly instead, calling the identical engine code the CLI
// would call.
//
// Politeness: one collector, one host, requests issued serially (queue.run
// mirrors src/net/politeness.ts's HostQueue exactly), matching docs/design.md
// §10's per-host concurrency-1 rule.
//
// Reproducing this hits the live Bright Data API (a real collector run per
// claim, plus a real heal cycle for the blindness case) and costs time and
// credits — it is committed as a record of what actually happened, not as a
// script meant to be re-run casually. Pass one or more claim-id suffixes
// (e.g. "senior-blind") as argv to check only those claims — useful because
// the heal cycle alone can take several minutes.

import { randomUUID } from "node:crypto";
import { openDb } from "../src/db/index.js";
import { checkAssertion } from "../src/engine/check.js";
import type { EngineDeps } from "../src/engine/check.js";
import { runCollector, healCollector, flagBlobCandidates } from "../src/collect/studio.js";
import { HostQueue } from "../src/net/politeness.js";
import type { Candidate } from "../src/model/types.js";
import type { CollectRunResult } from "../src/collect/types.js";

const DB_PATH = "examples/demo.db";
const ONLY = new Set(process.argv.slice(2));
const COLLECTOR_ID = "c_msx2l16bsipcs0zz"; // real collector, created + verified in the probe
const SOURCE_URL = "https://whalewatch.co.nz/your-experience/our-tours/whale-watch-tour/";
const DOCUMENT_ID = "kaikoura-whale-watch-demo";

// Hand-transcribed from the live page structure, per docs/probes/2026-08-17-scraper-studio.md
// and re-confirmed with a direct `bdata scraper run` against the live URL on 2026-08-17
// (same session, same output: Adult NZ$175, Child (3yrs-15yrs) NZ$60, heading
// "Ocean Cabin Pricing:"). Assertions 3 and 4 are deliberately counterfactual
// PRIOR CLAIMS (a stale price, a price the page never carried) so the real
// engine's DRIFTED and blindness/heal/REMOVED branches are genuinely exercised
// against genuine collector output — the collector's response is never altered.
const CLAIMS = [
  {
    id: `${DOCUMENT_ID}#adult-holds`,
    text: "Adult admission on the Whale Watch Kaikoura Ocean Cabin tour is NZ$175.",
    field: "adult_price", op: "eq" as const, valueNum: 175, unit: "NZD",
    anchorLabel: "Adult", anchorContext: "Ocean Cabin Pricing:",
  },
  {
    id: `${DOCUMENT_ID}#child-holds`,
    text: "Child (3-15 years) admission on the Ocean Cabin tour is NZ$60.",
    field: "child_price", op: "eq" as const, valueNum: 60, unit: "NZD",
    anchorLabel: "Child (3yrs-15yrs)", anchorContext: "Ocean Cabin Pricing:",
  },
  {
    id: `${DOCUMENT_ID}#adult-drifted`,
    text: "[deliberately stale, to exercise DRIFTED] Adult admission on the Ocean Cabin tour is NZ$170.",
    field: "adult_price", op: "eq" as const, valueNum: 170, unit: "NZD",
    anchorLabel: "Adult", anchorContext: "Ocean Cabin Pricing:",
  },
  {
    id: `${DOCUMENT_ID}#senior-blind`,
    text: "[deliberately unsupported, to exercise blindness/heal/REMOVED] Senior admission on the Ocean Cabin tour is NZ$140.",
    field: "senior_price", op: "eq" as const, valueNum: 140, unit: "NZD",
    anchorLabel: "Senior", anchorContext: "Ocean Cabin Pricing:",
  },
];

const CHECKED_AT = "2026-08-08T00:00:00Z"; // within the probe's live-page verification window

async function main() {
  const db = openDb(DB_PATH);
  const ingestedAt = new Date().toISOString();

  db.prepare(
    `INSERT OR REPLACE INTO documents (id, uri, title) VALUES (?, ?, ?)`,
  ).run(DOCUMENT_ID, SOURCE_URL, "Whale Watch Kaikoura - Ocean Cabin pricing (demo)");

  const insClaim = db.prepare(
    `INSERT OR REPLACE INTO claims
     (id,document_id,text,source_url,ingested_at,checked_at,volatile,expires_at,status)
     VALUES (@id,@documentId,@text,@sourceUrl,@ingestedAt,@checkedAt,@volatile,@expiresAt,@status)`);
  const insAssertion = db.prepare(
    `INSERT OR REPLACE INTO assertions
     (id,claim_id,field,op,value_num,value_text,value_max,unit,tolerance,anchor_label,anchor_context,anchor_path)
     VALUES (@id,@claimId,@field,@op,@valueNum,@valueText,@valueMax,@unit,@tolerance,@anchorLabel,@anchorContext,@anchorPath)`);

  for (const c of CLAIMS) {
    insClaim.run({
      id: c.id, documentId: DOCUMENT_ID, text: c.text, sourceUrl: SOURCE_URL,
      ingestedAt, checkedAt: CHECKED_AT, volatile: 0, expiresAt: null, status: "active",
    });
    insAssertion.run({
      id: `${c.id}:a1`, claimId: c.id, field: c.field, op: c.op,
      valueNum: c.valueNum, valueText: null, valueMax: null, unit: c.unit, tolerance: null,
      anchorLabel: c.anchorLabel, anchorContext: c.anchorContext, anchorPath: "",
    });
  }
  console.log(`Inserted ${CLAIMS.length} claims + assertions directly (ingest's normalizer bypassed - no Anthropic key on this machine).`);

  // Mirror src/cli.ts's `check` command exactly: same anchor screening
  // (flagBlobCandidates), same per-host serialization (HostQueue), same
  // EngineDeps wiring to the real collector + heal, same verdict insert shape.
  const queue = new HostQueue();
  const anchorLabels = CLAIMS.map((c) => c.anchorLabel);

  const wrapRun = (): EngineDeps["run"] => async (id, url) => {
    const result: CollectRunResult = await runCollector(id, url);
    if (result.status !== "ok") return result;
    const fields: Record<string, Candidate[]> = {};
    for (const [k, v] of Object.entries(result.record.fields)) {
      const kept = flagBlobCandidates(v, anchorLabels);
      if (kept.length > 0) fields[k] = kept;
    }
    const record = { ...result.record, fields };
    return Object.keys(fields).length > 0
      ? { status: "ok" as const, record }
      : { status: "empty" as const, record };
  };

  const insVerdict = db.prepare(
    `INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at)
     VALUES (?,?,?,?,?,?,?)`);
  const updLastChecked = db.prepare(`UPDATE claims SET last_checked_at = ? WHERE id = ?`);

  const toCheck = ONLY.size > 0
    ? CLAIMS.filter((c) => [...ONLY].some((s) => c.id.endsWith(s)))
    : CLAIMS;

  for (const c of toCheck) {
    const claimRow = db.prepare(`SELECT * FROM assertions WHERE claim_id = ?`).get(c.id) as any;
    const assertion = {
      id: claimRow.id, claimId: c.id, field: claimRow.field, op: claimRow.op,
      valueNum: claimRow.value_num, valueText: claimRow.value_text, valueMax: claimRow.value_max,
      unit: claimRow.unit, tolerance: claimRow.tolerance, anchorLabel: claimRow.anchor_label,
      anchorContext: claimRow.anchor_context, anchorPath: claimRow.anchor_path,
    };
    console.log(`\n--- checking ${c.id} ---`);
    const resolution = await queue.run(SOURCE_URL, () =>
      checkAssertion(assertion, COLLECTOR_ID, SOURCE_URL, {
        run: wrapRun(),
        heal: (id, prompt, url) => {
          console.log(`  [heal] prompt: ${prompt}`);
          return healCollector(id, prompt, { url, autoApprove: true });
        },
      }));
    const checkedAt = new Date().toISOString();
    insVerdict.run(randomUUID(), "", c.id, resolution.verdict, resolution.confidence,
      JSON.stringify(resolution), checkedAt);
    updLastChecked.run(checkedAt, c.id);
    console.log(`  verdict: ${resolution.verdict}\t confidence ${resolution.confidence.toFixed(2)}\t ${resolution.reason}`);
  }

  db.close();
  console.log(`\nDone. DB written to ${DB_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
