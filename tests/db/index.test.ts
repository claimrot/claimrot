import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
