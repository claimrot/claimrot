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
 * True when the assertion expects a NUMBER (a.valueNum !== null, on eq/approx/
 * range) but the candidate's value could not be parsed to one (c.value ===
 * null). That is not a mismatch — it is our own blindness to the value, and
 * `satisfies` would otherwise convict it (null !== 175) and produce a false
 * `DRIFTED`. Such a candidate is dropped before resolution rather than
 * scored against the assertion: if that empties `cleared`, resolveCandidates
 * correctly returns null and the caller heals instead of reporting drift.
 */
function isUnparseableNumeric(a: Assertion, c: ScoredCandidate): boolean {
  return (a.op === "eq" || a.op === "approx" || a.op === "range")
    && a.valueNum !== null && c.value === null;
}

/**
 * True when a candidate carries NOTHING — no numeric value and no text
 * either. That is total blindness, not a finding, regardless of `a.op`. Prior
 * to this check, only numeric ops (`isUnparseableNumeric` above) dropped an
 * unparseable candidate; a blank extraction under `op: "exists"` sailed
 * through the label filter untouched (`c.value !== null || (c.valueText ??
 * "") !== ""` in `satisfies` reads `null` / `""` as "does not exist") and
 * `satisfies` convicted it — a confident `DRIFTED` built entirely on our own
 * inability to read the page.
 */
function isBlind(c: ScoredCandidate): boolean {
  return c.value === null && (c.valueText ?? "") === "";
}

/**
 * Returns null when no candidate clears the threshold. Null is NOT a negative
 * finding — it means we could not see the value, and the caller must heal
 * before drawing any conclusion (spec §4.5).
 */
export function resolveCandidates(a: Assertion, cands: Candidate[]): Resolution | null {
  const scored = cands.map((c) => scoreCandidate(a, c)).sort((x, y) => y.score - x.score);
  const cleared = scored.filter((c) =>
    c.score >= CLEAR_THRESHOLD && !isUnparseableNumeric(a, c) && !isBlind(c));
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
