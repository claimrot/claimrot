import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { renderReceipts } from "../../src/report/receipts.js";

function dbWithClaim() {
  const db = openDb(":memory:");
  db.prepare(
    `INSERT INTO claims (id,document_id,text,source_url,ingested_at,checked_at,volatile,status)
     VALUES ('c','d','Adult price','https://x.example/p','2026-08-01','2026-08-01',0,'active')`,
  ).run();
  return db;
}

describe("renderReceipts current state", () => {
  it("survives malformed evidence and prints an honest fallback explanation", () => {
    const db = dbWithClaim();
    db.prepare(
      `INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at)
       VALUES ('v','','c','DRIFTED',0.8,'not json','2026-08-16')`,
    ).run();

    expect(() => renderReceipts(db, "DRIFTED")).not.toThrow();
    expect(renderReceipts(db, "DRIFTED")).toContain("No explanation was recorded");
  });

  it("does not print a stale historical verdict after the claim recovers", () => {
    const db = dbWithClaim();
    const insert = db.prepare(
      `INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at)
       VALUES (?,'','c',?,0.9,'{}',?)`,
    );
    insert.run("old", "DRIFTED", "2026-08-10");
    insert.run("new", "HOLDS", "2026-08-16");

    expect(renderReceipts(db, "DRIFTED")).toBe("No DRIFTED claims.");
  });
});
