CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, uri TEXT NOT NULL, title TEXT
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL, text TEXT NOT NULL,
  source_url TEXT NOT NULL, ingested_at TEXT NOT NULL, checked_at TEXT NOT NULL,
  volatile INTEGER NOT NULL, expires_at TEXT, status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS assertions (
  id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, field TEXT NOT NULL, op TEXT NOT NULL,
  value_num REAL, value_text TEXT, value_max REAL, unit TEXT, tolerance REAL,
  anchor_label TEXT NOT NULL, anchor_context TEXT NOT NULL, anchor_path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, run_at TEXT NOT NULL,
  collector_version TEXT, status TEXT NOT NULL, raw_snippet TEXT, latency_ms INTEGER
);
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY, check_id TEXT NOT NULL, field TEXT NOT NULL,
  value_num REAL, value_text TEXT, unit TEXT, label TEXT, context TEXT, path TEXT, score REAL
);
CREATE TABLE IF NOT EXISTS verdicts (
  id TEXT PRIMARY KEY, check_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  verdict TEXT NOT NULL, confidence REAL NOT NULL, evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_checked ON claims(checked_at);
CREATE INDEX IF NOT EXISTS idx_verdicts_claim ON verdicts(claim_id, created_at);
