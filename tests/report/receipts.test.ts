import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { renderVerdictsJson } from "../../src/report/receipts.js";
import { decideExit } from "../../action/main.js";

function seed() {
  const db = openDb(":memory:");
  db.prepare(
    `INSERT INTO claims (id,document_id,text,source_url,ingested_at,checked_at,volatile,status)
     VALUES (?,?,?,?,?,?,1,'active')`,
  ).run("c1", "d", "Adult admission is NZ$175.", "https://x.example/p", "2026-08-01", "2026-08-01");
  db.prepare(
    `INSERT INTO claims (id,document_id,text,source_url,ingested_at,checked_at,volatile,status)
     VALUES (?,?,?,?,?,?,1,'active')`,
  ).run("c2", "d", "Child admission is NZ$60.", "https://x.example/q", "2026-08-01", "2026-08-01");

  const verdict = db.prepare(
    `INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at)
     VALUES (?,'',?,?,?,'{}',?)`,
  );
  // c1 has TWO recorded verdicts — only the latest (by created_at) must appear.
  verdict.run("v1a", "c1", "HOLDS", 1, "2026-08-10T00:00:00Z");
  verdict.run("v1b", "c1", "DRIFTED", 0.95, "2026-08-16T00:00:00Z");
  verdict.run("v2", "c2", "UNVERIFIABLE", 0, "2026-08-16T00:00:00Z");
  return db;
}

describe("renderVerdictsJson", () => {
  it("emits exactly the {verdict, confidence, claim, url} shape action/main.ts reads", () => {
    const rows = renderVerdictsJson(seed());
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["claim", "confidence", "url", "verdict"]);
    }
  });

  it("keeps only the MOST RECENT verdict per claim", () => {
    const rows = renderVerdictsJson(seed());
    const c1 = rows.find((r) => r.claim === "Adult admission is NZ$175.")!;
    expect(c1.verdict).toBe("DRIFTED");
    expect(c1.confidence).toBe(0.95);
  });

  it("carries the real claim text and URL, not undefined — the examples/output.json regression", () => {
    // examples/output.json used {claimId, claimText, sourceUrl}; feeding that
    // straight to action/main.ts produced receipts reading "undefined
    // (undefined)". This asserts the producer's own output never does that.
    const rows = renderVerdictsJson(seed());
    for (const r of rows) {
      expect(r.claim).not.toBeUndefined();
      expect(r.url).not.toBeUndefined();
      expect(typeof r.claim).toBe("string");
      expect(typeof r.url).toBe("string");
    }
  });

  it("round-trips through the action's own decideExit with a real, honest result", () => {
    const rows = renderVerdictsJson(seed());
    const { code, summary } = decideExit(rows, 0.75);
    expect(code).toBe(1);                 // c1's DRIFTED at 0.95 clears the floor
    expect(summary).toMatch(/2 claim\(s\) checked/);
    expect(summary).toMatch(/1 failing/);
    expect(summary).toMatch(/1 unverifiable/);
  });
});
