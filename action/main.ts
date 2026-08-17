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

/**
 * A malformed floor (typo, stray quote, out-of-range value) must NOT silently
 * disable the gate. `Number("high")` is NaN, and every `confidence >= NaN`
 * comparison is false — so an unvalidated floor would make decideExit's
 * filter match nothing and the action would exit 0 on every run, including a
 * confident DRIFTED. That is a false assurance, not an honest absence like a
 * missing verdicts file, so we fall back to the documented default and warn
 * loudly rather than staying quiet.
 */
export function parseFloor(raw: string | undefined): { floor: number; warning: string | null } {
  if (raw === undefined || raw.trim() === "") return { floor: 0.75, warning: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    return {
      floor: 0.75,
      warning: `confidence-floor "${raw}" is not a number between 0 and 1; using the default 0.75.`,
    };
  }
  return { floor: n, warning: null };
}

function main(): void {
  const path = process.env.INPUT_VERDICTS ?? "claimrot-verdicts.json";
  const { floor, warning } = parseFloor(process.env["INPUT_CONFIDENCE-FLOOR"]);

  const { code, summary } = runAction(path, floor);
  const output = warning ? `${warning}\n${summary}` : summary;

  console.log(output);
  writeStepSummary(output);
  process.exitCode = code;
}

// Runs only when executed directly, so importing decideExit/runAction in
// tests stays pure.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
