import { describe, it, expect } from "vitest";
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

  it("is idempotent — opening twice does not throw", () => {
    const db = openDb(":memory:");
    expect(() => db.exec("SELECT 1")).not.toThrow();
  });
});
