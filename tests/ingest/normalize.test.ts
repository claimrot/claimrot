import { describe, it, expect } from "vitest";
import { normalizeClaim, NormalizedSchema } from "../../src/ingest/normalize.js";

const fakeParse = (out: unknown) => async () => out;

describe("normalizeClaim", () => {
  it("maps a parsed price assertion onto the Assertion shape", async () => {
    const assertions = await normalizeClaim(
      "Whale Watch's Ocean Cabin tour is NZ$175 per adult.",
      "c1",
      { parse: fakeParse({ assertions: [{
        field: "adult_price", op: "eq", valueNum: 175, valueText: null, valueMax: null,
        unit: "NZD", tolerance: null, anchorLabel: "Adult", anchorContext: "Ocean Cabin",
      }] }) },
    );
    expect(assertions).toHaveLength(1);
    expect(assertions[0].claimId).toBe("c1");
    expect(assertions[0].anchorLabel).toBe("Adult");
    expect(assertions[0].anchorPath).toBe("");   // filled on first successful check
  });

  it("returns [] for an untestable claim rather than inventing an assertion", async () => {
    const assertions = await normalizeClaim(
      "The harbour is a pleasant place to spend an afternoon.",
      "c2",
      { parse: fakeParse({ assertions: [] }) },
    );
    expect(assertions).toEqual([]);
  });

  it("accepts the documented schema shape", () => {
    expect(() => NormalizedSchema.parse({ assertions: [] })).not.toThrow();
  });

  it("drops an assertion with no anchor context rather than shipping one that can never be checked", async () => {
    // The scoring floor needs label + >=0.5 of the weight budget. A context-less
    // anchor against a real collector (no unit, no path) totals 0.40, scores zero,
    // and heals forever without ever returning a verdict. Refuse it at ingest.
    const assertions = await normalizeClaim("Adult entry is NZ$175.", "c1", {
      parse: async () => ({ assertions: [{
        field: "adult_price", op: "eq", valueNum: 175, valueText: null, valueMax: null,
        unit: "NZD", tolerance: null, anchorLabel: "Adult", anchorContext: "",
      }] }),
    });
    expect(assertions).toEqual([]);
  });
});
