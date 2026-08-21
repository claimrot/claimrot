CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, uri TEXT NOT NULL, title TEXT
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL, text TEXT NOT NULL,
  source_url TEXT NOT NULL, ingested_at TEXT NOT NULL,
  -- checked_at: when the SOURCE claim was last verified by whoever authored the
  -- fact pack. Immutable after ingest — the half-life study measures age against
  -- this column, so writing to it after ingest zeroes every age bucket.
  checked_at TEXT NOT NULL,
  volatile INTEGER NOT NULL, expires_at TEXT, status TEXT NOT NULL DEFAULT 'active',
  -- last_checked_at: when claimrot itself last ran a check for this claim. NULL
  -- means claimrot has never checked it. This is the scheduler's reference point.
  last_checked_at TEXT
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
  assertion_id TEXT,
  verdict TEXT NOT NULL, confidence REAL NOT NULL, evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS extraction_monitors (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  interval_days INTEGER NOT NULL DEFAULT 90,
  collector_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT
);
CREATE TABLE IF NOT EXISTS extraction_runs (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  collector_id TEXT NOT NULL,
  collector_version TEXT,
  heal_status TEXT NOT NULL DEFAULT 'NOT_NEEDED',
  error TEXT
);
CREATE TABLE IF NOT EXISTS extracted_values (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  monitor_id TEXT NOT NULL,
  field TEXT NOT NULL,
  field_type TEXT NOT NULL,
  status TEXT NOT NULL,
  value_num REAL,
  value_text TEXT,
  unit TEXT,
  label TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  error TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  scraped_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_checked ON claims(checked_at);
CREATE INDEX IF NOT EXISTS idx_verdicts_claim ON verdicts(claim_id, created_at);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_monitor
  ON extraction_runs(monitor_id, started_at);
CREATE INDEX IF NOT EXISTS idx_extracted_values_monitor
  ON extracted_values(monitor_id, field, scraped_at);
