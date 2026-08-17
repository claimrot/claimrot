import type Database from "better-sqlite3";
import type { VerdictRecord } from "../model/types.js";
type Db = Database.Database;

/**
 * The producer half of the `claimrot report --json` / GitHub Action pair
 * (§8.2). Emits exactly the `VerdictRecord` shape `action/main.ts` reads
 * (`verdict`, `confidence`, `claim`, `url`) — both sides import that type
 * from `src/model/types.ts` so they cannot drift apart again.
 *
 * One row per claim: its MOST RECENT verdict, not every verdict ever
 * recorded, since the action is deciding on the current state of each claim,
 * not its history. Unlike `renderReceipts`, this is never filtered by
 * verdict — the action needs the full checked set (including HOLDS and
 * UNVERIFIABLE) to report an honest "N checked / M failing" summary.
 *
 * The correlated `MAX(created_at)` alone ties whenever two verdicts for the
 * same claim share a timestamp (two checks in the same tick, or a clock with
 * coarser resolution than the check cadence) — the join then matches BOTH
 * rows and this emits two rows for one claim. `verdicts.id` is TEXT
 * (`${assertionId}:${Date.now()}`, `src/cli.ts`), not a sortable insertion
 * order, so it cannot break the tie. SQLite still assigns every ordinary
 * (non-`WITHOUT ROWID`) table an implicit, monotonically increasing `rowid`
 * regardless of its declared primary key — breaking the tie on `MAX(rowid)`
 * picks exactly one, the most recently inserted, verdict per claim.
 */
export function renderVerdictsJson(db: Db): VerdictRecord[] {
  const rows = db.prepare(
    `SELECT c.text AS claim, c.source_url AS url, v.verdict AS verdict, v.confidence AS confidence
     FROM verdicts v
     JOIN claims c ON c.id = v.claim_id
     WHERE v.created_at = (
       SELECT MAX(v2.created_at) FROM verdicts v2 WHERE v2.claim_id = v.claim_id
     )
     AND v.rowid = (
       SELECT MAX(v3.rowid) FROM verdicts v3
       WHERE v3.claim_id = v.claim_id AND v3.created_at = v.created_at
     )
     ORDER BY c.id`).all() as VerdictRecord[];
  return rows;
}

export function renderReceipts(db: Db, verdict: string): string {
  const rows = db.prepare(
    `SELECT c.text AS text, c.source_url AS url, v.verdict AS verdict,
            v.confidence AS confidence, v.evidence_json AS evidence, v.created_at AS ranAt
     FROM verdicts v JOIN claims c ON c.id = v.claim_id
     WHERE v.verdict = ? ORDER BY v.created_at DESC`).all(verdict) as any[];

  if (rows.length === 0) return `No ${verdict} claims.`;

  return rows.map((r) => {
    const e = JSON.parse(r.evidence);
    return [
      `${r.verdict}  (confidence ${r.confidence.toFixed(2)}, checked ${r.ranAt.slice(0, 10)})`,
      `  published: ${r.text.slice(0, 200)}`,
      `  source:    ${r.url}`,
      `  now:       ${e.chosen ? `"${e.chosen.label}" = ${e.chosen.value ?? e.chosen.valueText}` : "-"}`,
      `  why:       ${e.reason}`,
    ].join("\n");
  }).join("\n\n");
}
