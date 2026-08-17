import type { Assertion, Claim, Op } from "../model/types.js";

/** Raw `assertions` table row shape (sqlite column names), before mapping to Assertion. */
export interface AssertionRow {
  id: string;
  claim_id: string;
  field: string;
  op: string;
  value_num: number | null;
  value_text: string | null;
  value_max: number | null;
  unit: string | null;
  tolerance: number | null;
  anchor_label: string;
  anchor_context: string;
  anchor_path: string;
}

/** Raw `claims` table row shape (sqlite column names), before mapping to Claim. */
export interface ClaimRow {
  id: string;
  document_id: string;
  text: string;
  source_url: string;
  ingested_at: string;
  checked_at: string;
  volatile: number;
  expires_at: string | null;
  status: string;
  last_checked_at: string | null;
}

export function rowToAssertion(row: AssertionRow): Assertion {
  return {
    id: row.id, claimId: row.claim_id, field: row.field, op: row.op as Op,
    valueNum: row.value_num, valueText: row.value_text, valueMax: row.value_max,
    unit: row.unit, tolerance: row.tolerance, anchorLabel: row.anchor_label,
    anchorContext: row.anchor_context, anchorPath: row.anchor_path,
  };
}

export function rowToClaim(row: ClaimRow): Claim {
  return {
    id: row.id, documentId: row.document_id, text: row.text, sourceUrl: row.source_url,
    ingestedAt: row.ingested_at, checkedAt: row.checked_at, volatile: !!row.volatile,
    expiresAt: row.expires_at, status: row.status as Claim["status"],
  };
}
