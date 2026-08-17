import { describe, it, expect } from "vitest";
import { openDb } from "../../src/db/index.js";
import { halfLife } from "../../src/report/study.js";

describe("halfLife", () => {
  it("buckets drift rate by claim age", () => {
    const db = openDb(":memory:");
    const claim = db.prepare(
      `INSERT INTO claims (id,document_id,text,source_url,ingested_at,checked_at,volatile,status)
       VALUES (?,?,?,?,?,?,1,'active')`);
    const verdict = db.prepare(
      `INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at)
       VALUES (?,'',?,?,1.0,'{}',?)`);

    claim.run("c1", "d", "t", "https://x.example/", "", "2026-08-15");  // 2 days old
    claim.run("c2", "d", "t", "https://x.example/", "", "2026-07-28");  // 20 days old
    verdict.run("v1", "c1", "HOLDS", "2026-08-17");
    verdict.run("v2", "c2", "DRIFTED", "2026-08-17");

    const study = halfLife(db);
    const old = study.buckets.find((b) => b.maxAgeDays >= 20)!;
    expect(old.drifted).toBe(1);
    expect(study.note).toMatch(/9.20 day/);   // the honesty bound, stated in the output
  });

  it("excludes UNVERIFIABLE from the denominator", () => {
    const db = openDb(":memory:");
    db.prepare(`INSERT INTO claims (id,document_id,text,source_url,ingested_at,checked_at,volatile,status)
                VALUES ('c1','d','t','https://x.example/','','2026-08-15',1,'active')`).run();
    db.prepare(`INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at)
                VALUES ('v1','','c1','UNVERIFIABLE',0,'{}','2026-08-17')`).run();
    expect(halfLife(db).buckets.every((b) => b.checked === 0)).toBe(true);
  });
});
