// Driver for the committed example output (examples/output.json).
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
// Bright Data collector ID this probe actually created. So this script
// supplies the real collector ID directly instead, calling the identical
// engine code (checkAssertion, withBlobScreening, HostQueue) the CLI would
// call.
//
// Politeness: one collector, one host, requests issued serially through the
// same src/net/politeness.ts HostQueue the CLI uses, matching docs/design.md
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
import { rowToAssertion } from "../src/db/rows.js";
import type { AssertionRow } from "../src/db/rows.js";
import { INSERT_CLAIM_SQL, INSERT_ASSERTION_SQL, INSERT_VERDICT_SQL, UPDATE_LAST_CHECKED_SQL } from "../src/db/statements.js";
import { checkAssertion } from "../src/engine/check.js";
import type { EngineDeps } from "../src/engine/check.js";
import { runCollector, healCollector, withBlobScreening } from "../src/collect/studio.js";
import { HostQueue } from "../src/net/politeness.js";

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

  const insClaim = db.prepare(INSERT_CLAIM_SQL);
  const insAssertion = db.prepare(INSERT_ASSERTION_SQL);

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
  // (withBlobScreening), same per-host serialization (HostQueue), same
  // EngineDeps wiring to the real collector + heal, same verdict insert shape.
  const queue = new HostQueue();
  const anchorLabels = CLAIMS.map((c) => c.anchorLabel);
  const wrapRun: EngineDeps["run"] = withBlobScreening(runCollector, anchorLabels);

  const insVerdict = db.prepare(INSERT_VERDICT_SQL);
  const updLastChecked = db.prepare(UPDATE_LAST_CHECKED_SQL);

  const toCheck = ONLY.size > 0
    ? CLAIMS.filter((c) => [...ONLY].some((s) => c.id.endsWith(s)))
    : CLAIMS;

  for (const c of toCheck) {
    const claimRow = db.prepare(`SELECT * FROM assertions WHERE claim_id = ?`).get(c.id) as AssertionRow;
    const assertion = rowToAssertion(claimRow);
    console.log(`\n--- checking ${c.id} ---`);
    const resolution = await queue.run(SOURCE_URL, () =>
      checkAssertion(assertion, COLLECTOR_ID, SOURCE_URL, {
        run: wrapRun,
        heal: (id, prompt, url) => {
          console.log(`  [heal] prompt: ${prompt}`);
          return healCollector(id, prompt, { url, autoApprove: true });
        },
      }));
    const checkedAt = new Date().toISOString();
    insVerdict.run(randomUUID(), "", c.id, assertion.id, resolution.verdict, resolution.confidence,
      JSON.stringify(resolution), checkedAt);
    updLastChecked.run(checkedAt, c.id);
    console.log(`  verdict: ${resolution.verdict}\t confidence ${resolution.confidence.toFixed(2)}\t ${resolution.reason}`);
  }

  db.close();
  console.log(`\nDone. DB written to ${DB_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
