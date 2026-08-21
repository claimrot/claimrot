import type Database from "better-sqlite3";
import type { Verdict, VerdictRecord } from "../model/types.js";
import { currentClaimRows, isVerdict, readEvidence } from "./current.js";
type Db = Database.Database;

/**
 * The producer half of the `claimrot report --json` / GitHub Action pair
 * (§8.2). Emits exactly the `VerdictRecord` shape `action/main.ts` reads
 * (`verdict`, `confidence`, `claim`, `url`) — both sides import that type
 * from `src/model/types.ts` so they cannot drift apart again.
 *
 * One row per claim: the most severe CURRENT assertion verdict, not every
 * verdict ever recorded, since the action is deciding on the current state,
 * not its history. Unlike `renderReceipts`, this is never filtered by
 * verdict — the action needs the full checked set (including HOLDS and
 * UNVERIFIABLE) to report an honest "N checked / M failing" summary.
 *
 * A claim can contain several assertions. currentClaimRows first selects the
 * latest verdict for each assertion (with rowid as the timestamp tie-break),
 * then surfaces the most severe of those current assertion states.
 */
export function renderVerdictsJson(db: Db): VerdictRecord[] {
  return currentClaimRows(db).flatMap((row): VerdictRecord[] => isVerdict(row.verdict)
    ? [{
      verdict: row.verdict,
      confidence: row.confidence ?? 0,
      claim: row.claim,
      url: row.url,
    }]
    : []);
}

export function renderReceipts(db: Db, verdict: Verdict): string {
  const rows = currentClaimRows(db).filter((row) => row.verdict === verdict);

  if (rows.length === 0) return `No ${verdict} claims.`;

  return rows.map((r) => {
    const e = readEvidence(r.evidence);
    const reason = typeof e.reason === "string" && e.reason.trim()
      ? e.reason
      : "No explanation was recorded for this check.";
    return [
      `${r.verdict}  (confidence ${(r.confidence ?? 0).toFixed(2)}, checked ${(r.ranAt ?? "unknown").slice(0, 10)})`,
      `  published: ${r.claim.slice(0, 200)}`,
      `  source:    ${r.url}`,
      // Only a relocated anchor carries foundAt, and when it does it IS the
      // fix — the line to paste back into the document.
      ...(e.foundAt ? [`  now at:    ${e.foundAt}`] : []),
      `  now:       ${e.chosen ? `"${e.chosen.label}" = ${e.chosen.value ?? e.chosen.valueText}` : "-"}`,
      `  why:       ${reason}`,
    ].join("\n");
  }).join("\n\n");
}
