import type Database from "better-sqlite3";
import type { Resolution, Verdict } from "../model/types.js";

type Db = Database.Database;

export interface ReportClaimRow {
  claimId: string;
  documentTitle: string | null;
  claim: string;
  url: string;
  status: string;
  verdict: string | null;
  confidence: number | null;
  evidence: string | null;
  ranAt: string | null;
  assertionCount: number;
  repeatAmbiguous: boolean;
}

const VERDICTS = new Set<string>([
  "HOLDS", "DRIFTED", "MOVED", "REMOVED", "AMBIGUOUS", "CONFLICT", "UNVERIFIABLE",
]);

export function isVerdict(value: string | null): value is Verdict {
  return value !== null && VERDICTS.has(value);
}

export function readEvidence(value: string | null): Partial<Resolution> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Partial<Resolution> : {};
  } catch {
    return {};
  }
}

export function repeatAmbiguousClaimIds(db: Db): string[] {
  const rows = db.prepare(
    `SELECT claim_id FROM (
       SELECT claim_id, COALESCE(assertion_id, '__legacy__') AS assertion_key, verdict,
              ROW_NUMBER() OVER (
                PARTITION BY claim_id, COALESCE(assertion_id, '__legacy__')
                ORDER BY created_at DESC, rowid DESC
              ) AS rn
       FROM verdicts
     ) WHERE rn <= 2 GROUP BY claim_id, assertion_key
       HAVING COUNT(*) = 2 AND SUM(verdict = 'AMBIGUOUS') = 2`,
  ).all() as { claim_id: string }[];
  return [...new Set(rows.map((row) => row.claim_id))];
}

/**
 * One current row per non-retired claim. A claim may contain multiple
 * independently checked assertions, so first select the newest verdict for
 * each assertion and then select the most severe of those current verdicts.
 * Legacy rows without assertion_id remain one history stream per claim.
 */
export function currentClaimRows(db: Db): ReportClaimRow[] {
  const rows = db.prepare(
    `WITH ranked_assertions AS (
       SELECT v.*, v.rowid AS verdict_rowid,
              ROW_NUMBER() OVER (
                PARTITION BY v.claim_id, COALESCE(v.assertion_id, '__legacy__')
                ORDER BY v.created_at DESC, v.rowid DESC
              ) AS assertion_rank
       FROM verdicts v
     ),
     current_assertions AS (
       SELECT * FROM ranked_assertions WHERE assertion_rank = 1
     ),
     ranked_claims AS (
       SELECT v.*,
              ROW_NUMBER() OVER (
                PARTITION BY v.claim_id
                ORDER BY CASE v.verdict
                  WHEN 'DRIFTED' THEN 1 WHEN 'REMOVED' THEN 2 WHEN 'MOVED' THEN 3
                  WHEN 'CONFLICT' THEN 4 WHEN 'AMBIGUOUS' THEN 5
                  WHEN 'UNVERIFIABLE' THEN 6 WHEN 'HOLDS' THEN 7 ELSE 0 END,
                  v.created_at DESC, v.verdict_rowid DESC
              ) AS claim_rank
       FROM current_assertions v
     )
     SELECT c.id AS claimId, d.title AS documentTitle, c.text AS claim,
            c.source_url AS url, c.status AS status, v.verdict AS verdict,
            v.confidence AS confidence, v.evidence_json AS evidence,
            v.created_at AS ranAt,
            (SELECT COUNT(*) FROM assertions a WHERE a.claim_id = c.id) AS assertionCount
     FROM claims c
     LEFT JOIN documents d ON d.id = c.document_id
     LEFT JOIN ranked_claims v ON v.claim_id = c.id AND v.claim_rank = 1
     WHERE c.status <> 'retired'
     ORDER BY CASE
       WHEN v.verdict IS NULL THEN 9
       WHEN v.verdict = 'DRIFTED' THEN 1 WHEN v.verdict = 'REMOVED' THEN 2
       WHEN v.verdict = 'MOVED' THEN 3 WHEN v.verdict = 'CONFLICT' THEN 4
       WHEN v.verdict = 'AMBIGUOUS' THEN 5 WHEN v.verdict = 'UNVERIFIABLE' THEN 6
       WHEN v.verdict = 'HOLDS' THEN 7 ELSE 0 END,
       v.created_at DESC, c.id`,
  ).all() as Omit<ReportClaimRow, "repeatAmbiguous">[];
  const repeats = new Set(repeatAmbiguousClaimIds(db));
  return rows.map((row) => ({ ...row, repeatAmbiguous: repeats.has(row.claimId) }));
}
