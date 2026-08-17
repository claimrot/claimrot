export type Op = "eq" | "approx" | "range" | "contains" | "exists";

export type Verdict =
  | "HOLDS"
  | "DRIFTED"
  | "AMBIGUOUS"
  | "CONFLICT"
  | "MOVED"
  | "REMOVED"
  | "UNVERIFIABLE";

export interface Assertion {
  id: string;
  claimId: string;
  field: string;
  op: Op;
  valueNum: number | null;
  valueText: string | null;
  valueMax: number | null;   // upper bound when op === "range"
  unit: string | null;
  tolerance: number | null;  // fractional, e.g. 0.02, when op === "approx"
  anchorLabel: string;
  anchorContext: string;
  anchorPath: string;
}

export interface Claim {
  id: string;
  documentId: string;
  text: string;
  sourceUrl: string;
  ingestedAt: string;
  checkedAt: string;
  volatile: boolean;
  expiresAt: string | null;
  status: "active" | "untestable" | "retired";
}

/** What a collector emits per candidate. Never a bare value. */
export interface Candidate {
  value: number | null;
  valueText: string | null;
  unit: string | null;
  label: string;
  context: string;
  path: string;
}

export interface ScoredCandidate extends Candidate {
  score: number;
  signals: {
    labelSimilarity: number | null;
    contextSimilarity: number | null;
    corroboration: number | null;
    unitMatch: number | null;
    pathStability: number | null;
  };
}

export interface Resolution {
  verdict: Verdict;
  confidence: number;
  chosen: ScoredCandidate | null;
  contenders: ScoredCandidate[];
  reason: string;
  /**
   * Set only when the anchor was found somewhere other than the cited URL.
   * The cited URL stays on the claim — this records where the value actually
   * lives now, so a MOVED receipt can tell you what to change the citation to.
   */
  foundAt?: string;
}

/**
 * A single row of the verdicts JSON file that `claimrot report --json`
 * produces and `action/main.ts` consumes. Defined once, here, and imported by
 * both sides so the producer and the consumer cannot drift apart the way
 * `report`'s human output and the action's expected `{claim, url, ...}` shape
 * once did (examples/output.json used `{claimId, claimText, sourceUrl, ...}`
 * and fed the action `undefined (undefined)` receipts).
 */
export interface VerdictRecord {
  verdict: Verdict;
  confidence: number;
  claim: string;
  url: string;
}
