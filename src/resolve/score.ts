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
 */
export function scoreCandidate(a: Assertion, c: Candidate): ScoredCandidate {
  const signals = {
    labelSimilarity: similarity(a.anchorLabel, c.label),
    contextSimilarity: similarity(a.anchorContext, c.context),
    corroboration: 0, // raised by the engine when a second source agrees
    unitMatch: a.unit && c.unit ? (norm(a.unit) === norm(c.unit) ? 1 : 0) : 0.5,
    pathStability: pathStability(a.anchorPath, c.path),
  };
  const score = (Object.keys(W) as (keyof typeof W)[])
    .reduce((sum, k) => sum + W[k] * signals[k], 0);
  return { ...c, score, signals };
}
