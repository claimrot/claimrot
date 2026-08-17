import { describe, it, expect } from "vitest";
import { decideExit } from "../../action/main.js";

describe("decideExit", () => {
  it("fails on a confident DRIFTED", () => {
    expect(decideExit([{ verdict: "DRIFTED", confidence: 0.9 }], 0.75).code).toBe(1);
  });

  it("passes when the only drift is below the confidence floor", () => {
    expect(decideExit([{ verdict: "DRIFTED", confidence: 0.5 }], 0.75).code).toBe(0);
  });

  it("NEVER fails the build on UNVERIFIABLE — that is the whole thesis", () => {
    expect(decideExit([{ verdict: "UNVERIFIABLE", confidence: 0 }], 0.0).code).toBe(0);
  });

  it("does not fail on AMBIGUOUS either", () => {
    expect(decideExit([{ verdict: "AMBIGUOUS", confidence: 0.9 }], 0.75).code).toBe(0);
  });

  it("passes a clean run", () => {
    expect(decideExit([{ verdict: "HOLDS", confidence: 1 }], 0.75).code).toBe(0);
  });
});
