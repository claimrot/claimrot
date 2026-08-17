import { describe, it, expect } from "vitest";
import { checkAssertion, healPrompt } from "../../src/engine/check.js";
import type { EngineDeps } from "../../src/engine/check.js";
import type { Assertion } from "../../src/model/types.js";
import type { CollectRunResult, HealResult } from "../../src/collect/types.js";

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

  it("resolves candidates when the collector names its field differently", async () => {
    // Probe A returns {"prices": [...]} while the assertion says "adult_price".
    // Keying on the field name made every real check heal and then report
    // REMOVED on a page that still publishes the value.
    const deps: EngineDeps = {
      run: async () => ({
        status: "ok",
        record: {
          url: "u", fetchedAt: "t", collectorVersion: "v", pageSignature: "",
          fields: { prices: [cand(175)] },      // collector's name, not ours
        },
      }),
      heal: async () => { throw new Error("must not heal — the value is visible"); },
    };
    const r = await checkAssertion(a, "c_1", "https://x.example/p", deps);
    expect(r.verdict).toBe("HOLDS");
  });

  it("treats an ok run with no clearing candidate as blindness, not evidence", async () => {
    // A candidate came back, but its label ("Parking") doesn't anchor to
    // "Adult" well enough to clear the threshold. That is still blindness —
    // it must heal, not silently fall through unresolved.
    let heals = 0;
    const deps: EngineDeps = {
      run: async () => record([cand(175, "Parking")]),
      heal: async () => { heals++; return { status: "failed", error: "x" }; },
    };
    const r = await checkAssertion(a, "c_1", "https://x.example/p", deps);
    expect(r.verdict).not.toBe("HOLDS");
    expect(r.verdict).not.toBe("DRIFTED");
    expect(heals).toBe(1);
  });

  // THE INVARIANT.
  it("never reports DRIFTED for any combination of failure and heal outcome", async () => {
    const runs: CollectRunResult[] = [
      { status: "error", error: "500" },
      { status: "error", error: "timeout" },
      record([]),
    ];
    const heals: HealResult[] = [
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

describe("healPrompt", () => {
  it("names the anchor label so the heal knows what it went blind to", () => {
    const prompt = healPrompt(a);
    expect(prompt).toContain(a.anchorLabel);
  });

  it("never exceeds the CLI's 1000-character cap even with a pathological anchor", () => {
    const pathological: Assertion = {
      ...a,
      anchorLabel: "x".repeat(5000),
      anchorContext: "y".repeat(5000),
    };
    const prompt = healPrompt(pathological);
    expect(prompt.length).toBeLessThanOrEqual(1000);
  });
});
