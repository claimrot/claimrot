import { describe, it, expect } from "vitest";
import { checkAssertion } from "../../src/engine/check.js";
import type { EngineDeps } from "../../src/engine/check.js";
import type { Assertion } from "../../src/model/types.js";
import type { CollectRunResult } from "../../src/collect/types.js";

const a: Assertion = {
  id: "a1", claimId: "c1", field: "adult_price", op: "eq",
  valueNum: 175, valueText: null, valueMax: null, unit: "NZD", tolerance: null,
  anchorLabel: "Adult", anchorContext: "Ocean Cabin", anchorPath: "div>td",
};

const record = (cands: any[]): CollectRunResult => ({
  status: cands.length ? "ok" : "empty",
  record: {
    url: "u", fetchedAt: "t", collectorVersion: "v", pageSignature: "",
    fields: { adult_price: cands },
  },
});
const cand = (value: number, label = "Adult") =>
  ({ value, valueText: null, unit: "NZD", label, context: "Ocean Cabin", path: "div>td" });

describe("checkAssertion", () => {
  it("HOLDS without ever healing when the value matches", async () => {
    let heals = 0;
    const deps: EngineDeps = {
      run: async () => record([cand(175)]),
      heal: async () => { heals++; return { status: "failed", error: "should not be called" }; },
    };
    const r = await checkAssertion(a, "c_1", "https://x.example/p", deps);
    expect(r.verdict).toBe("HOLDS");
    expect(heals).toBe(0);
  });

  it("DRIFTED without healing — heal fires on blindness, never on change", async () => {
    let heals = 0;
    const deps: EngineDeps = {
      run: async () => record([cand(185)]),
      heal: async () => { heals++; return { status: "failed", error: "x" }; },
    };
    const r = await checkAssertion(a, "c_1", "https://x.example/p", deps);
    expect(r.verdict).toBe("DRIFTED");
    expect(heals).toBe(0);
  });

  it("heals on empty, then reports the healed collector's finding", async () => {
    let calls = 0;
    const deps: EngineDeps = {
      run: async () => (++calls === 1 ? record([]) : record([cand(185)])),
      heal: async () => ({ status: "healed", collectorVersion: "v2", preview: {} }),
    };
    const r = await checkAssertion(a, "c_1", "https://x.example/p", deps);
    expect(r.verdict).toBe("DRIFTED");
    expect(calls).toBe(2);
  });

  it("REMOVED only when a HEALED collector still finds nothing", async () => {
    const deps: EngineDeps = {
      run: async () => record([]),
      heal: async () => ({ status: "healed", collectorVersion: "v2", preview: {} }),
    };
    const r = await checkAssertion(a, "c_1", "https://x.example/p", deps);
    expect(r.verdict).toBe("REMOVED");
  });

  it("UNVERIFIABLE when the heal itself fails", async () => {
    const deps: EngineDeps = {
      run: async () => record([]),
      heal: async () => ({ status: "failed", error: "heal blew up" }),
    };
    const r = await checkAssertion(a, "c_1", "https://x.example/p", deps);
    expect(r.verdict).toBe("UNVERIFIABLE");
  });

  it("UNVERIFIABLE when a heal is still awaiting approval", async () => {
    const deps: EngineDeps = {
      run: async () => record([]),
      heal: async () => ({ status: "awaiting_approval", preview: {} }),
    };
    const r = await checkAssertion(a, "c_1", "https://x.example/p", deps);
    expect(r.verdict).toBe("UNVERIFIABLE");
  });

  // THE INVARIANT.
  it("never reports DRIFTED for any combination of failure and heal outcome", async () => {
    const runs: CollectRunResult[] = [
      { status: "error", error: "500" },
      { status: "error", error: "timeout" },
      record([]),
    ];
    const heals: any[] = [
      { status: "failed", error: "x" },
      { status: "awaiting_approval", preview: {} },
      { status: "healed", collectorVersion: "v2", preview: {} },
    ];
    for (const run of runs) {
      for (const heal of heals) {
        const r = await checkAssertion(a, "c_1", "https://x.example/p", {
          run: async () => run,
          heal: async () => heal,
        });
        expect(r.verdict).not.toBe("DRIFTED");
      }
    }
  });
});
