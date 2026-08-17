import { describe, it, expect } from "vitest";
import { buildProgram, UPDATE_LAST_CHECKED_SQL, repeatAmbiguousClaims } from "../src/cli.js";
import { openDb } from "../src/db/index.js";

describe("cli", () => {
  it("registers every documented command", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names.sort()).toEqual(["check", "ingest", "report", "study"]);
  });

  it("check's own update statement advances last_checked_at without disturbing checked_at", () => {
    // checked_at is the SOURCE's verification date and is what the half-life
    // study measures against. Advancing it on every run zeroes every age bucket
    // and makes the study report 0% drift at every horizon. This asserts the
    // EXACT statement cli.ts prepares in `check` — a hand-written duplicate
    // here would not catch a regression if that statement were changed back
    // to target checked_at.
    expect(UPDATE_LAST_CHECKED_SQL).toMatch(/\bSET\s+last_checked_at\s*=/i);
    expect(UPDATE_LAST_CHECKED_SQL).not.toMatch(/\bSET\s+checked_at\s*=/i);

    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO claims (id,document_id,text,source_url,ingested_at,checked_at,volatile,status)
       VALUES ('c1','d','t','https://x.example/','2026-08-01','2026-07-28',1,'active')`,
    ).run();
    db.prepare(UPDATE_LAST_CHECKED_SQL).run("2026-08-17", "c1");
    const row = db.prepare(`SELECT checked_at, last_checked_at FROM claims WHERE id='c1'`).get() as any;
    expect(row.checked_at).toBe("2026-07-28");        // untouched
    expect(row.last_checked_at).toBe("2026-08-17");
  });
});

describe("repeatAmbiguousClaims", () => {
  const insertVerdict = (db: ReturnType<typeof openDb>, claimId: string, verdict: string, createdAt: string) =>
    db.prepare(
      `INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(`${claimId}:${createdAt}`, "", claimId, verdict, 0.5, "{}", createdAt);

  it("flags a claim whose two most recent verdicts are both AMBIGUOUS", () => {
    const db = openDb(":memory:");
    insertVerdict(db, "c1", "AMBIGUOUS", "2026-08-01T00:00:00Z");
    insertVerdict(db, "c1", "AMBIGUOUS", "2026-08-08T00:00:00Z");
    expect(repeatAmbiguousClaims(db)).toContain("c1");
  });

  it("does not flag AMBIGUOUS followed by HOLDS", () => {
    const db = openDb(":memory:");
    insertVerdict(db, "c2", "AMBIGUOUS", "2026-08-01T00:00:00Z");
    insertVerdict(db, "c2", "HOLDS", "2026-08-08T00:00:00Z");
    expect(repeatAmbiguousClaims(db)).not.toContain("c2");
  });
});
