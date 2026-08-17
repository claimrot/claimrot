import { describe, it, expect } from "vitest";
import { scoreCandidate, CLEAR_THRESHOLD } from "../../src/resolve/score.js";
import type { Assertion, Candidate } from "../../src/model/types.js";

const assertion: Assertion = {
  id: "a1", claimId: "c1", field: "adult_price", op: "eq",
  valueNum: 175, valueText: null, valueMax: null, unit: "NZD", tolerance: null,
  anchorLabel: "Adult", anchorContext: "Ocean Cabin", anchorPath: "div>table>tr:nth-child(1)>td",
};

const cand = (over: Partial<Candidate>): Candidate => ({
  value: 175, valueText: null, unit: "NZD", label: "Adult",
  context: "Ocean Cabin", path: assertion.anchorPath, ...over,
});

describe("scoreCandidate", () => {
  it("scores an exact label+context+unit+path match near 1", () => {
    const s = scoreCandidate(assertion, cand({}));
    // Perfect anchor match renormalises to 1.0: corroboration is unavailable
    // at this layer (excluded from both sums) until the engine raises it.
    expect(s.score).toBeGreaterThanOrEqual(0.85);
  });

  it("clears the threshold on a label match even when the DOM path moved", () => {
    // A redesign destroys the path. Label carries identity — this must still clear.
    // Renormalised over available signals this is 0.75/0.85 ≈ 0.8824, safely
    // clear of CLEAR_THRESHOLD rather than sitting exactly on it.
    const s = scoreCandidate(assertion, cand({ path: "section>div>span" }));
    expect(s.score).toBeGreaterThan(CLEAR_THRESHOLD - 1e-9);
  });

  it("scores a different label far below the threshold", () => {
    const s = scoreCandidate(assertion, cand({ label: "Child (3-15)", value: 60 }));
    expect(s.score).toBeLessThan(CLEAR_THRESHOLD);
  });

  it("scores unit+path agreement below threshold when label and context are both present but wrong", () => {
    // Path is the weakest signal and must never carry a match by itself.
    // Label and context stay present (not empty) here, so they remain in the
    // denominator scored at 0 — this is a low-score case, not a floor case.
    // The floor itself (label unavailable) is covered by the test below.
    const s = scoreCandidate(assertion, cand({ label: "Senior", context: "Other", unit: "AUD" }));
    expect(s.score).toBeLessThan(CLEAR_THRESHOLD);
  });

  it("refuses to clear on unit+path alone when the anchor is empty", () => {
    // Ruling 6's renormalisation collapsed the denominator to 0.20 here, letting
    // the two WEAKEST signals produce a confidence-1.0 verdict. Spec 4.2: path is
    // never used alone.
    const anchorless = { ...assertion, anchorLabel: "", anchorContext: "" };
    const s = scoreCandidate(anchorless, cand({}));
    expect(s.score).toBe(0);
  });

  it("KNOWN GAP: a blob label containing the anchor scores as a full match", () => {
    // Deferred to Task 5's adapter by ruling — scoring cannot separate a blob from
    // a legitimate qualifier structurally. Documented, not accepted.
    const s = scoreCandidate(assertion, cand({ label: "Adult Child Senior" }));
    expect(s.signals.labelSimilarity).toBe(1);
  });

  it("ignores the candidate's value entirely when scoring", () => {
    // Anchor on the label, verify the value. Score must not peek at the value.
    const a = scoreCandidate(assertion, cand({ value: 175 }));
    const b = scoreCandidate(assertion, cand({ value: 999 }));
    expect(a.score).toBeCloseTo(b.score, 10);
  });

  it("scores a candidate carrying EXTRA qualifying context as a full match", () => {
    // Asymmetric by design: the page volunteering "to 30 Sep 2026" on top of
    // "Ocean Cabin" is more informative, not less. Symmetric Jaccard scored
    // this 0.33 and made the AMBIGUOUS branch unreachable on real pages.
    const s = scoreCandidate(assertion, cand({ context: "Ocean Cabin to 30 Sep 2026" }));
    expect(s.signals.contextSimilarity).toBe(1);
  });

  it("clears on a real collector's output, which carries no DOM path", () => {
    // Probe A (2026-08-17): live collectors emit no path, and corroboration is
    // engine-only. Scored naively that is 0.25 of the weight budget stuck at
    // zero, putting a PERFECT match at exactly CLEAR_THRESHOLD and making every
    // real check fall through to heal. Renormalising over available signals is
    // what keeps the monitor able to say anything but "unverifiable".
    const s = scoreCandidate(assertion, cand({ path: "" }));
    expect(s.score).toBe(1);
    expect(s.signals.pathStability).toBeNull();
  });
});
