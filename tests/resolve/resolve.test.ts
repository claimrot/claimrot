import { describe, it, expect } from "vitest";
import { resolveCandidates } from "../../src/resolve/resolve.js";
import type { Assertion, Candidate } from "../../src/model/types.js";

const base: Assertion = {
  id: "a1", claimId: "c1", field: "adult_price", op: "eq",
  valueNum: 175, valueText: null, valueMax: null, unit: "NZD", tolerance: null,
  anchorLabel: "Adult", anchorContext: "Ocean Cabin", anchorPath: "div>table>tr>td",
};
const c = (o: Partial<Candidate>): Candidate => ({
  value: null, valueText: null, unit: "NZD", label: "Adult",
  context: "Ocean Cabin", path: base.anchorPath, ...o,
});

describe("resolveCandidates", () => {
  it("HOLDS when one candidate clears and matches", () => {
    const r = resolveCandidates(base, [c({ value: 175 })])!;
    expect(r.verdict).toBe("HOLDS");
  });

  it("DRIFTED when one candidate clears and differs", () => {
    const r = resolveCandidates(base, [c({ value: 185 })])!;
    expect(r.verdict).toBe("DRIFTED");
    expect(r.chosen!.value).toBe(185);
  });

  it("returns null when nothing clears — the caller must heal, not report drift", () => {
    const r = resolveCandidates(base, [c({ label: "Parking", context: "Footer", unit: "x", path: "footer" })]);
    expect(r).toBeNull();
  });

  it("AMBIGUOUS on two equally-anchored candidates that disagree", () => {
    // Whale Watch publishes the current AND post-1-October adult price on one page.
    const r = resolveCandidates(base, [
      c({ value: 175, context: "Ocean Cabin to 30 Sep 2026" }),
      c({ value: 185, context: "Ocean Cabin from 1 Oct 2026" }),
    ])!;
    expect(r.verdict).toBe("AMBIGUOUS");
    expect(r.contenders.length).toBeGreaterThanOrEqual(2);
  });

  it("DRIFTED, not HOLDS, when the value migrated to another label", () => {
    // The scar: NZ$59 was the adult fare and is now the senior fare.
    // Anchoring on the label catches it; anchoring on the value would not.
    const adult59: Assertion = { ...base, valueNum: 59 };
    const r = resolveCandidates(adult59, [
      c({ value: 65, label: "Adult" }),
      c({ value: 59, label: "Senior" }),
    ])!;
    expect(r.verdict).toBe("DRIFTED");
    expect(r.chosen!.label).toBe("Adult");
    expect(r.chosen!.value).toBe(65);
  });

  it("honours approx tolerance", () => {
    const approx: Assertion = { ...base, op: "approx", tolerance: 0.05 };
    expect(resolveCandidates(approx, [c({ value: 179 })])!.verdict).toBe("HOLDS");
    expect(resolveCandidates(approx, [c({ value: 240 })])!.verdict).toBe("DRIFTED");
  });

  it("honours range bounds", () => {
    const range: Assertion = { ...base, op: "range", valueNum: 150, valueMax: 200 };
    expect(resolveCandidates(range, [c({ value: 175 })])!.verdict).toBe("HOLDS");
    expect(resolveCandidates(range, [c({ value: 220 })])!.verdict).toBe("DRIFTED");
  });
});
