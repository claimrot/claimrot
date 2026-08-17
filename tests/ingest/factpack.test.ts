import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFactPack } from "../../src/ingest/factpack.js";

describe("readFactPack", () => {
  it("maps facts to claims and excludes authenticated hosts", () => {
    const dir = mkdtempSync(join(tmpdir(), "claimrot-"));
    const p = join(dir, "what-to-do-in-kaikoura.facts.json");
    writeFileSync(p, JSON.stringify({
      slug: "what-to-do-in-kaikoura",
      as_of: "2026-08-02",
      facts: [
        { id: "f1", claim: "Adult fare is NZ$175.", source_url: "https://whalewatch.co.nz/tours/", checked_at: "2026-08-02", volatile: true },
        { id: "f2", claim: "Duration is 2.5 hours.", source_url: "https://api.viator.com/x", checked_at: "2026-08-02", volatile: false },
      ],
    }));

    const claims = readFactPack(p);
    expect(claims).toHaveLength(1);                       // api.viator.com excluded
    expect(claims[0].id).toBe("what-to-do-in-kaikoura#f1");
    expect(claims[0].volatile).toBe(true);
    expect(claims[0].checkedAt).toBe("2026-08-02");
  });
});
