import { appendFileSync, readFileSync } from "node:fs";
import type { Verdict } from "../src/model/types.js";

/** A single row from the verdicts JSON file produced by `claimrot report`. */
export interface VerdictRecord {
  verdict: Verdict;
  confidence: number;
  claim: string;
  url: string;
}

function isFailingFinding(
  v: { verdict: Verdict; confidence: number }, floor: number,
): boolean {
  return (v.verdict === "DRIFTED" || v.verdict === "REMOVED") && v.confidence >= floor;
}

/**
 * UNVERIFIABLE and AMBIGUOUS never fail a build. A monitor whose negatives are
 * untrustworthy gets switched off within a fortnight, and then it protects
 * nobody. Only a confident DRIFTED or REMOVED is worth a red check.
 */
export function decideExit(
  verdicts: { verdict: Verdict; confidence: number }[], floor: number,
): { code: number; summary: string } {
  const failing = verdicts.filter((v) => isFailingFinding(v, floor));
  const unverifiable = verdicts.filter((v) => v.verdict === "UNVERIFIABLE").length;

  const summary = [
    `${verdicts.length} claim(s) checked`,
    `${failing.length} failing above the ${floor} confidence floor`,
    unverifiable ? `${unverifiable} unverifiable (not counted against you)` : null,
  ].filter(Boolean).join(" · ");

  return { code: failing.length > 0 ? 1 : 0, summary };
}

/**
 * Reads and parses the verdicts file. Returns null on ANY failure — missing
 * file, unreadable file, malformed JSON, or JSON that isn't an array. null is
 * the signal to the caller: skip, don't fail, this is our artefact's problem
 * not the PR's.
 */
function readVerdicts(path: string): VerdictRecord[] | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VerdictRecord[]) : null;
  } catch {
    return null;
  }
}

/**
 * The policy-enforcement half of the action: load the verdicts file, decide
 * pass/fail, and produce the receipts (claim + URL) for each failing finding.
 * A missing or unreadable verdicts file is reported and never fails the
 * build — same reasoning as UNVERIFIABLE: failing a PR because our own
 * artefact is absent would make the check untrustworthy.
 */
export function runAction(path: string, floor: number): { code: number; summary: string } {
  const records = readVerdicts(path);
  if (records === null) {
    return {
      code: 0,
      summary: `claimrot: no readable verdicts file at ${path} — skipping (this does not fail the build)`,
    };
  }

  const { code, summary } = decideExit(records, floor);
  const receipts = records
    .filter((r) => isFailingFinding(r, floor))
    .map((r) => `  - ${r.claim} (${r.url})`);

  return { code, summary: receipts.length ? [summary, ...receipts].join("\n") : summary };
}

function writeStepSummary(text: string): void {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    appendFileSync(target, `${text}\n`);
  } catch {
    // best effort — never fail the build over the summary write
  }
}

function main(): void {
  const path = process.env.INPUT_VERDICTS ?? "claimrot-verdicts.json";
  const floor = Number(process.env["INPUT_CONFIDENCE-FLOOR"] ?? "0.75");

  const { code, summary } = runAction(path, floor);

  console.log(summary);
  writeStepSummary(summary);
  process.exitCode = code;
}

// Runs only when executed directly, so importing decideExit/runAction in
// tests stays pure.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
