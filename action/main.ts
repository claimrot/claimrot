import type { Verdict } from "../src/model/types.js";

/**
 * UNVERIFIABLE and AMBIGUOUS never fail a build. A monitor whose negatives are
 * untrustworthy gets switched off within a fortnight, and then it protects
 * nobody. Only a confident DRIFTED or REMOVED is worth a red check.
 */
export function decideExit(
  verdicts: { verdict: Verdict; confidence: number }[], floor: number,
): { code: number; summary: string } {
  const failing = verdicts.filter(
    (v) => (v.verdict === "DRIFTED" || v.verdict === "REMOVED") && v.confidence >= floor,
  );
  const unverifiable = verdicts.filter((v) => v.verdict === "UNVERIFIABLE").length;

  const summary = [
    `${verdicts.length} claim(s) checked`,
    `${failing.length} drifted above the ${floor} confidence floor`,
    unverifiable ? `${unverifiable} unverifiable (not counted against you)` : null,
  ].filter(Boolean).join(" · ");

  return { code: failing.length > 0 ? 1 : 0, summary };
}
