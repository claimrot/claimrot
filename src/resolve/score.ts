import type { Assertion, Candidate, ScoredCandidate } from "../model/types.js";

export const CLEAR_THRESHOLD = 0.75;
export const MARGIN = 0.15;

const W = {
  labelSimilarity: 0.46,
  contextSimilarity: 0.25,
  corroboration: 0.04,
  unitMatch: 0.1,
  pathStability: 0.15,
} as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Token-set Jaccard. Cheap, order-insensitive, good enough for short labels. */
export function similarity(a: string, b: string): number {
  const A = new Set(norm(a).split(" ").filter(Boolean));
  const B = new Set(norm(b).split(" ").filter(Boolean));
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
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
