import type Database from "better-sqlite3";        // the Database NAMESPACE
import type { Verdict } from "../model/types.js";
type Db = Database.Database;                       // the connection type

const BUCKETS = [7, 14, 21, 30];

interface HalfLifeRow {
  checkedAt: string;
  verdict: Verdict;
  ranAt: string;
}

/**
 * Drift rate as a function of claim age — the measured half-life of a published fact.
 * UNVERIFIABLE is excluded from the denominator: it is a statement about our
 * eyesight, not about the claim.
 */
export function halfLife(db: Db) {
  const rows = db.prepare(
    `SELECT c.checked_at AS checkedAt, v.verdict AS verdict, v.created_at AS ranAt
     FROM verdicts v JOIN claims c ON c.id = v.claim_id`).all() as HalfLifeRow[];

  const buckets = BUCKETS.map((maxAgeDays) => {
    const inBucket = rows.filter((r) => {
      const age = (new Date(r.ranAt).getTime() - new Date(r.checkedAt).getTime()) / 86_400_000;
      return age <= maxAgeDays && r.verdict !== "UNVERIFIABLE";
    });
    const drifted = inBucket.filter((r) => r.verdict === "DRIFTED" || r.verdict === "REMOVED").length;
    return {
      maxAgeDays,
      checked: inBucket.length,
      drifted,
      rate: inBucket.length ? drifted / inBucket.length : 0,
    };
  });

  return {
    buckets,
    note: "Corpus checked_at dates span 2026-07-28 to 2026-08-08, so this measures 9-20 day decay only. It does not support any claim about longer horizons.",
  };
}
