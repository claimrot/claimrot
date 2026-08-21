import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { currentClaimRows } from "../../src/report/current.js";
import { renderVerdictsJson } from "../../src/report/receipts.js";

function addClaim(db: ReturnType<typeof openDb>, id: string, status = "active") {
  db.prepare(
    `INSERT INTO claims (id,document_id,text,source_url,ingested_at,checked_at,volatile,status)
     VALUES (?,?,?,?,?,?,0,?)`,
  ).run(id, "doc", `Claim ${id}`, `https://x.example/${id}`, "2026-08-01", "2026-08-01", status);
}

function addAssertion(db: ReturnType<typeof openDb>, id: string, claimId: string) {
  db.prepare(
    `INSERT INTO assertions
       (id,claim_id,field,op,value_num,value_text,value_max,unit,tolerance,anchor_label,anchor_context,anchor_path)
     VALUES (?,?,'price','eq',1,NULL,NULL,'NZD',NULL,'Adult','','')`,
  ).run(id, claimId);
}

function addVerdict(
  db: ReturnType<typeof openDb>, id: string, claimId: string, assertionId: string | null,
  verdict: string, at: string,
) {
  db.prepare(
    `INSERT INTO verdicts
       (id,check_id,claim_id,assertion_id,verdict,confidence,evidence_json,created_at)
     VALUES (?,'',?,?,?,0.9,'{}',?)`,
  ).run(id, claimId, assertionId, verdict, at);
}

describe("currentClaimRows", () => {
  it("keeps every assertion current and surfaces the most severe state per claim", () => {
    const db = openDb(":memory:");
    addClaim(db, "c1");
    addAssertion(db, "c1:a1", "c1");
    addAssertion(db, "c1:a2", "c1");
    addVerdict(db, "v1", "c1", "c1:a1", "DRIFTED", "2026-08-10T00:00:00Z");
    addVerdict(db, "v2", "c1", "c1:a2", "HOLDS", "2026-08-16T00:00:00Z");

    expect(currentClaimRows(db)[0]).toMatchObject({ verdict: "DRIFTED", assertionCount: 2 });
    expect(renderVerdictsJson(db)[0].verdict).toBe("DRIFTED");

    addVerdict(db, "v3", "c1", "c1:a1", "HOLDS", "2026-08-17T00:00:00Z");
    expect(currentClaimRows(db)[0].verdict).toBe("HOLDS");
  });

  it("uses insertion order to break equal-timestamp ties within an assertion", () => {
    const db = openDb(":memory:");
    addClaim(db, "c1");
    addAssertion(db, "c1:a1", "c1");
    const at = "2026-08-16T00:00:00Z";
    addVerdict(db, "v1", "c1", "c1:a1", "HOLDS", at);
    addVerdict(db, "v2", "c1", "c1:a1", "DRIFTED", at);

    expect(currentClaimRows(db)[0].verdict).toBe("DRIFTED");
  });

  it("treats assertion-less legacy verdicts as one latest-per-claim stream", () => {
    const db = openDb(":memory:");
    addClaim(db, "c1");
    addVerdict(db, "legacy-1", "c1", null, "DRIFTED", "2026-08-10T00:00:00Z");
    addVerdict(db, "legacy-2", "c1", null, "HOLDS", "2026-08-16T00:00:00Z");

    expect(currentClaimRows(db)[0].verdict).toBe("HOLDS");
  });

  it("includes never-checked claims and excludes retired ones", () => {
    const db = openDb(":memory:");
    addClaim(db, "active");
    addClaim(db, "retired", "retired");

    expect(currentClaimRows(db)).toEqual([
      expect.objectContaining({ claimId: "active", verdict: null, ranAt: null }),
    ]);
    expect(renderVerdictsJson(db)).toEqual([]);
  });
});
