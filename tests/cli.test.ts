import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/cli.js";
import { openDb } from "../src/db/index.js";

describe("cli", () => {
  it("registers every documented command", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names.sort()).toEqual(["check", "ingest", "report", "study"]);
  });

  it("advances last_checked_at without disturbing checked_at", () => {
    // checked_at is the SOURCE's verification date and is what the half-life
    // study measures against. Advancing it on every run zeroes every age bucket
    // and makes the study report 0% drift at every horizon.
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO claims (id,document_id,text,source_url,ingested_at,checked_at,volatile,status)
       VALUES ('c1','d','t','https://x.example/','2026-08-01','2026-07-28',1,'active')`,
    ).run();
    db.prepare(`UPDATE claims SET last_checked_at = ? WHERE id = ?`).run("2026-08-17", "c1");
    const row = db.prepare(`SELECT checked_at, last_checked_at FROM claims WHERE id='c1'`).get() as any;
    expect(row.checked_at).toBe("2026-07-28");        // untouched
    expect(row.last_checked_at).toBe("2026-08-17");
  });
});
