import type { Assertion, Candidate, Resolution, ScoredCandidate } from "../model/types.js";
import { scoreCandidate, CLEAR_THRESHOLD, MARGIN } from "./score.js";

function satisfies(a: Assertion, c: ScoredCandidate): boolean {
  switch (a.op) {
    case "eq":
      return a.valueNum !== null
        ? c.value === a.valueNum
        : (c.valueText ?? "").trim() === (a.valueText ?? "").trim();
    case "approx": {
      if (a.valueNum === null || c.value === null) return false;
      const tol = a.tolerance ?? 0.02;
      return Math.abs(c.value - a.valueNum) <= Math.abs(a.valueNum) * tol;
    }
    case "range":
      return c.value !== null && a.valueNum !== null && a.valueMax !== null
        && c.value >= a.valueNum && c.value <= a.valueMax;
    case "contains":
      return (c.valueText ?? "").toLowerCase().includes((a.valueText ?? "").toLowerCase());
    case "exists":
      return c.value !== null || (c.valueText ?? "") !== "";
  }
}

const sameValue = (x: ScoredCandidate, y: ScoredCandidate) =>
  x.value === y.value && (x.valueText ?? "") === (y.valueText ?? "");

/**
 * Returns null when no candidate clears the threshold. Null is NOT a negative
 * finding — it means we could not see the value, and the caller must heal
 * before drawing any conclusion (spec §4.5).
 */
export function resolveCandidates(a: Assertion, cands: Candidate[]): Resolution | null {
  const scored = cands.map((c) => scoreCandidate(a, c)).sort((x, y) => y.score - x.score);
  const cleared = scored.filter((c) => c.score >= CLEAR_THRESHOLD);
  if (cleared.length === 0) return null;

  const [top] = cleared;
  // Agreement must span EVERY cleared candidate, not just the runner-up.
  // With cleared values [175, 175, 185] (spec §4.3's own sample payload),
  // checking only the top two misses the disagreeing third and reports a
  // confident HOLDS instead of surfacing the conflict.
  const disagreeing = cleared.filter((c) => !sameValue(top, c));
  const disagree = disagreeing.length > 0;
  // cleared is sorted by score descending, so disagreeing[0] is the
  // highest-scoring candidate that disagrees with top — margin is measured
  // against IT, not simply against cleared[1].
  const topDisagreeing = disagreeing[0];
  const margin = topDisagreeing === undefined ? 1 : top.score - topDisagreeing.score;

  if (disagree && margin < MARGIN) {
    return {
      verdict: "AMBIGUOUS",
      confidence: top.score,
      chosen: null,
      contenders: cleared,
      reason: `${cleared.length} candidates cleared with disagreeing values and only ${margin.toFixed(2)} separating the top from the nearest disagreement`,
    };
  }

  const holds = satisfies(a, top);
  return {
    verdict: holds ? "HOLDS" : "DRIFTED",
    confidence: disagree ? top.score * 0.9 : top.score,
    chosen: top,
    contenders: cleared,
    reason: holds
      ? `"${top.label}" still satisfies the assertion`
      : `"${top.label}" now reads ${top.value ?? top.valueText}, expected ${a.valueNum ?? a.valueText}`,
  };
}
