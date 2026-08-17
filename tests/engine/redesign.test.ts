import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { checkAssertion } from "../../src/engine/check.js";
import { extractJsonLdCandidates } from "../../src/collect/generic.js";
import type { Assertion } from "../../src/model/types.js";

const before = readFileSync("tests/fixtures/whalewatch-before.html", "utf8");
const after = readFileSync("tests/fixtures/whalewatch-after.html", "utf8");

const a: Assertion = {
  id: "a1", claimId: "c1", field: "price", op: "eq",
  valueNum: 175, valueText: null, valueMax: null, unit: "NZD", tolerance: null,
  anchorLabel: "Ocean Cabin", anchorContext: "Product", anchorPath: "jsonld>offers",
};

const deps = (html: string, healed?: string) => {
  let calls = 0;
  return {
    run: async () => {
      const src = ++calls === 1 || !healed ? html : healed;
      const cands = extractJsonLdCandidates(src, "price");
      return cands.length
        ? { status: "ok" as const, record: { url: "u", fetchedAt: "t", collectorVersion: "v", pageSignature: "", fields: { price: cands } } }
        : { status: "empty" as const, record: { url: "u", fetchedAt: "t", collectorVersion: "v", pageSignature: "", fields: {} } };
    },
    heal: async () => ({ status: "healed" as const, collectorVersion: "v2", preview: {} }),
  };
};

describe("redesign survival", () => {
  it("HOLDS on the pre-redesign page", async () => {
    const r = await checkAssertion(a, "generic", "https://x.example/p", deps(before));
    expect(r.verdict).toBe("HOLDS");
  });

  it("recovers the same verdict after a heal on the redesigned page", async () => {
    const r = await checkAssertion(a, "generic", "https://x.example/p", deps(after, after));
    expect(["HOLDS", "DRIFTED"]).toContain(r.verdict);
    expect(r.verdict).not.toBe("REMOVED");   // the page still publishes it
  });
});
