import type { Assertion, Candidate, ScoredCandidate } from "../model/types.js";

export const CLEAR_THRESHOLD = 0.75;
export const MARGIN = 0.15;

const W = {
  labelSimilarity: 0.4,
  contextSimilarity: 0.25,
  corroboration: 0.15,
  unitMatch: 0.1,
  pathStability: 0.1,
} as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Asymmetric coverage: how much of the ANCHOR survives in the candidate.
 * Deliberately not symmetric — a candidate carrying extra qualifying detail
 * ("Ocean Cabin to 30 Sep 2026" for anchor "Ocean Cabin") is a better match,
 * not a worse one, and symmetric Jaccard scored it worse.
 *
 * Argument order matters: pass the assertion's anchor FIRST, the candidate's
 * field SECOND — similarity(a.anchorLabel, c.label). Reversing it inverts
 * the metric silently.
 */
export function similarity(anchor: string, candidate: string): number {
  const A = new Set(norm(anchor).split(" ").filter(Boolean));
  const B = new Set(norm(candidate).split(" ").filter(Boolean));
  if (A.size === 0) return B.size === 0 ? 1 : 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / A.size;
}

/** Longest common prefix of DOM path segments, as a fraction of the anchor's depth. */
function pathStability(anchor: string, actual: string): number {
  const a = anchor.split(">");
  const b = actual.split(">");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.length === 0 ? 0 : i / a.length;
}

/**
 * Score a candidate against an assertion's ANCHOR — never against its value.
 * Reading the value here would let a migrated number fake a match (spec §4.2).
 *
 * Real collectors don't emit every signal (e.g. no DOM path), and
 * `corroboration` is engine-only at this layer. An absent signal is "no
 * evidence", not "contradicting evidence" — it's excluded from BOTH the
 * numerator and denominator, so the score renormalises over whatever
 * evidence actually exists instead of being capped by evidence we never had
 * a chance to collect (probe A, 2026-08-17).
 *
 * Renormalising alone opens a hole: with both anchorLabel and anchorContext
 * empty, the denominator can collapse to unit+path (0.20), letting the two
 * WEAKEST signals alone produce a confidence-1.0 match. Spec §4.2: path is
 * never used alone. So a score is only ever non-zero when labelSimilarity is
 * available AND the available weights total at least 0.5 — otherwise there
 * isn't enough evidence to convict, full stop (ruling 6 follow-up).
 */
export function scoreCandidate(a: Assertion, c: Candidate): ScoredCandidate {
  const signals: ScoredCandidate["signals"] = {
    labelSimilarity: a.anchorLabel === "" ? null : similarity(a.anchorLabel, c.label),
    contextSimilarity: a.anchorContext === "" ? null : similarity(a.anchorContext, c.context),
    corroboration: null, // engine-only; unavailable at this layer, never scored 0
    unitMatch: a.unit === null || c.unit === null
      ? null
      : (norm(a.unit) === norm(c.unit) ? 1 : 0),
    pathStability: a.anchorPath === "" || c.path === "" ? null : pathStability(a.anchorPath, c.path),
  };

  let weightedSum = 0;
  let weightTotal = 0;
  for (const k of Object.keys(W) as (keyof typeof W)[]) {
    const s = signals[k];
    if (s === null) continue;
    weightedSum += W[k] * s;
    weightTotal += W[k];
  }
  const hasFloor = signals.labelSimilarity !== null && weightTotal >= 0.5;
  const score = hasFloor ? weightedSum / weightTotal : 0;

  return { ...c, score, signals };
}
