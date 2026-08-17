import { appendFileSync, readFileSync } from "node:fs";
function isFailingFinding(v, floor) {
    return (v.verdict === "DRIFTED" || v.verdict === "REMOVED") && v.confidence >= floor;
}
/**
 * UNVERIFIABLE and AMBIGUOUS never fail a build. A monitor whose negatives are
 * untrustworthy gets switched off within a fortnight, and then it protects
 * nobody. Only a confident DRIFTED or REMOVED is worth a red check.
 */
export function decideExit(verdicts, floor) {
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
function readVerdicts(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    }
    catch {
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
export function runAction(path, floor) {
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
function writeStepSummary(text) {
    const target = process.env.GITHUB_STEP_SUMMARY;
    if (!target)
        return;
    try {
        appendFileSync(target, `${text}\n`);
    }
    catch {
        // best effort — never fail the build over the summary write
    }
}
// Deliberately independent of resolve/score.ts's CLEAR_THRESHOLD: that
// threshold decides whether a candidate anchors well enough to be scored at
// all, while this is the action's own policy knob for how confident a
// DRIFTED/REMOVED finding must be before it fails a build. They happen to
// share a value today; nothing requires them to stay in sync.
const DEFAULT_CONFIDENCE_FLOOR = 0.75;
/**
 * A malformed floor (typo, stray quote, out-of-range value) must NOT silently
 * disable the gate. `Number("high")` is NaN, and every `confidence >= NaN`
 * comparison is false — so an unvalidated floor would make decideExit's
 * filter match nothing and the action would exit 0 on every run, including a
 * confident DRIFTED. That is a false assurance, not an honest absence like a
 * missing verdicts file, so we fall back to the documented default and warn
 * loudly rather than staying quiet.
 */
export function parseFloor(raw) {
    if (raw === undefined || raw.trim() === "")
        return { floor: DEFAULT_CONFIDENCE_FLOOR, warning: null };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
        return {
            floor: DEFAULT_CONFIDENCE_FLOOR,
            warning: `confidence-floor "${raw}" is not a number between 0 and 1; using the default ${DEFAULT_CONFIDENCE_FLOOR}.`,
        };
    }
    return { floor: n, warning: null };
}
function main() {
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
