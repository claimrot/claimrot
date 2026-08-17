// Shared SQL, used by both `claimrot ingest`/`claimrot check` (src/cli.ts) and
// the demo driver (examples/produce-output.ts) that writes rows against the
// exact same schema outside the normal ingest path.

export const INSERT_CLAIM_SQL = `INSERT OR REPLACE INTO claims
   (id,document_id,text,source_url,ingested_at,checked_at,volatile,expires_at,status)
   VALUES (@id,@documentId,@text,@sourceUrl,@ingestedAt,@checkedAt,@volatile,@expiresAt,@status)`;

export const INSERT_ASSERTION_SQL = `INSERT OR REPLACE INTO assertions
   (id,claim_id,field,op,value_num,value_text,value_max,unit,tolerance,anchor_label,anchor_context,anchor_path)
   VALUES (@id,@claimId,@field,@op,@valueNum,@valueText,@valueMax,@unit,@tolerance,@anchorLabel,@anchorContext,@anchorPath)`;

export const INSERT_VERDICT_SQL =
  `INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at)
   VALUES (?,?,?,?,?,?,?)`;

// Exported (not just used inline) so a regression test can assert this exact
// string targets last_checked_at — checked_at must never be written after
// ingest, since report/study.ts measures claim age against it.
export const UPDATE_LAST_CHECKED_SQL = `UPDATE claims SET last_checked_at = ? WHERE id = ?`;
