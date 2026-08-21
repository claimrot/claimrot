import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../../src/db/index.js";

describe("openDb", () => {
  it("creates every table on a fresh database", () => {
    const db = openDb(":memory:");
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    for (const t of ["documents", "claims", "assertions", "checks", "candidates", "verdicts"]) {
      expect(names).toContain(t);
    }
  });

  it("is idempotent — reopening the same file does not throw and keeps prior data", () => {
    const dir = mkdtempSync(join(tmpdir(), "claimrot-db-"));
    const path = join(dir, "claimrot.db");
    try {
      const first = openDb(path);
      first.prepare(
        `INSERT INTO documents (id, uri, title) VALUES (?, ?, ?)`,
      ).run("doc1", "https://x.example", "Test doc");
      first.close();

      const second = openDb(path);
      expect(() => second.exec("SELECT 1")).not.toThrow();
      const row = second.prepare("SELECT id FROM documents WHERE id = ?").get("doc1");
      expect(row).toBeTruthy();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds assertion_id to historical verdict tables and backfills CLI-style IDs", () => {
    const dir = mkdtempSync(join(tmpdir(), "claimrot-db-"));
    const path = join(dir, "legacy.db");
    try {
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE assertions (
          id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, field TEXT NOT NULL, op TEXT NOT NULL,
          value_num REAL, value_text TEXT, value_max REAL, unit TEXT, tolerance REAL,
          anchor_label TEXT NOT NULL, anchor_context TEXT NOT NULL, anchor_path TEXT NOT NULL
        );
        CREATE TABLE verdicts (
          id TEXT PRIMARY KEY, check_id TEXT NOT NULL, claim_id TEXT NOT NULL,
          verdict TEXT NOT NULL, confidence REAL NOT NULL, evidence_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO assertions VALUES ('c:a1','c','price','eq',1,NULL,NULL,NULL,NULL,'Adult','','');
        INSERT INTO verdicts VALUES ('c:a1:123','','c','HOLDS',1,'{}','2026-08-01');
      `);
      legacy.close();

      const migrated = openDb(path);
      const columns = migrated.prepare("PRAGMA table_info(verdicts)").all() as { name: string }[];
      expect(columns.map((column) => column.name)).toContain("assertion_id");
      const row = migrated.prepare("SELECT assertion_id FROM verdicts").get() as { assertion_id: string };
      expect(row.assertion_id).toBe("c:a1");
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
