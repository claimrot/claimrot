import type Database from "better-sqlite3";
type Db = Database.Database;

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
