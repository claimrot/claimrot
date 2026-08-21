import type Database from "better-sqlite3";
import type { ExtractionDefinition } from "./schema.js";
import type {
  ExtractedFieldResult, ExtractionHealStatus, ExtractionMonitor, ExtractionRunStatus,
  ExtractionRunSummary, MonitorSnapshot,
} from "./types.js";

type Db = Database.Database;

interface MonitorRow {
  id: string;
  source_url: string;
  schema_json: string;
  interval_days: number;
  collector_id: string;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: ExtractionRunStatus | null;
}

interface RunRow {
  id: string;
  monitor_id: string;
  started_at: string;
  completed_at: string | null;
  status: ExtractionRunStatus;
  dry_run: number;
  collector_id: string;
  collector_version: string | null;
  heal_status: ExtractionHealStatus;
  error: string | null;
}

interface ValueRow {
  field: string;
  field_type: ExtractedFieldResult["type"];
  status: ExtractedFieldResult["status"];
  value_num: number | null;
  value_text: string | null;
  unit: string | null;
  label: string;
  context: string;
  path: string;
  confidence: number;
  error: string | null;
  evidence_json: string;
}

function monitorFromRow(row: MonitorRow): ExtractionMonitor {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    definition: JSON.parse(row.schema_json) as ExtractionDefinition,
    intervalDays: row.interval_days,
    collectorId: row.collector_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastStatus: row.last_status,
  };
}

function runFromRow(row: RunRow): ExtractionRunSummary {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    dryRun: Boolean(row.dry_run),
    collectorId: row.collector_id,
    collectorVersion: row.collector_version,
    healStatus: row.heal_status,
    error: row.error,
  };
}

function fieldFromRow(row: ValueRow): ExtractedFieldResult {
  return {
    field: row.field,
    type: row.field_type,
    status: row.status,
    value: row.value_num ?? row.value_text,
    valueNum: row.value_num,
    valueText: row.value_text,
    unit: row.unit,
    label: row.label,
    context: row.context,
    path: row.path,
    confidence: row.confidence,
    error: row.error,
    evidence: JSON.parse(row.evidence_json),
  };
}

export function upsertExtractionMonitor(
  db: Db,
  input: {
    id: string;
    sourceUrl: string;
    definition: ExtractionDefinition;
    intervalDays: number;
    collectorId: string;
    now: string;
  },
): ExtractionMonitor {
  db.prepare(
    `INSERT INTO extraction_monitors
       (id, source_url, schema_json, interval_days, collector_id, created_at, updated_at)
     VALUES (@id, @sourceUrl, @schemaJson, @intervalDays, @collectorId, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       source_url=excluded.source_url,
       schema_json=excluded.schema_json,
       interval_days=excluded.interval_days,
       collector_id=excluded.collector_id,
       updated_at=excluded.updated_at`,
  ).run({ ...input, schemaJson: JSON.stringify(input.definition) });
  return getExtractionMonitor(db, input.id)!;
}

export function getExtractionMonitor(db: Db, id: string): ExtractionMonitor | null {
  const row = db.prepare("SELECT * FROM extraction_monitors WHERE id = ?").get(id) as
    MonitorRow | undefined;
  return row ? monitorFromRow(row) : null;
}

export function listExtractionMonitors(db: Db): ExtractionMonitor[] {
  return (db.prepare("SELECT * FROM extraction_monitors ORDER BY id").all() as MonitorRow[])
    .map(monitorFromRow);
}

export function insertExtractionRun(
  db: Db,
  input: { id: string; monitorId: string; startedAt: string; dryRun: boolean; collectorId: string },
): void {
  db.prepare(
    `INSERT INTO extraction_runs
       (id, monitor_id, started_at, status, dry_run, collector_id, heal_status)
     VALUES (?, ?, ?, 'RUNNING', ?, ?, 'NOT_NEEDED')`,
  ).run(input.id, input.monitorId, input.startedAt, input.dryRun ? 1 : 0, input.collectorId);
}

export function finishExtractionRun(
  db: Db,
  input: {
    id: string;
    monitorId: string;
    completedAt: string;
    status: ExtractionRunStatus;
    collectorVersion: string | null;
    healStatus: ExtractionHealStatus;
    error: string | null;
    dryRun: boolean;
    nextRunAt: string | null;
  },
): void {
  db.prepare(
    `UPDATE extraction_runs SET completed_at=?, status=?, collector_version=?, heal_status=?, error=?
     WHERE id=?`,
  ).run(
    input.completedAt, input.status, input.collectorVersion,
    input.healStatus, input.error, input.id,
  );
  if (!input.dryRun) {
    db.prepare(
      `UPDATE extraction_monitors
       SET last_run_at=?, next_run_at=?, last_status=?, updated_at=? WHERE id=?`,
    ).run(input.completedAt, input.nextRunAt, input.status, input.completedAt, input.monitorId);
  }
}

export function insertExtractedFields(
  db: Db,
  input: { runId: string; monitorId: string; scrapedAt: string; fields: ExtractedFieldResult[] },
): void {
  const insert = db.prepare(
    `INSERT INTO extracted_values
       (id, run_id, monitor_id, field, field_type, status, value_num, value_text, unit,
        label, context, path, confidence, error, evidence_json, scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const transaction = db.transaction(() => {
    input.fields.forEach((field) => insert.run(
      `${input.runId}:${field.field}`, input.runId, input.monitorId, field.field, field.type,
      field.status, field.valueNum, field.valueText, field.unit, field.label, field.context,
      field.path, field.confidence, field.error, JSON.stringify(field.evidence), input.scrapedAt,
    ));
  });
  transaction();
}

function runRows(db: Db, monitorId: string, limit = 10): ExtractionRunSummary[] {
  return (db.prepare(
    `SELECT * FROM extraction_runs WHERE monitor_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
  ).all(monitorId, limit) as RunRow[]).map(runFromRow);
}

export function getMonitorSnapshot(db: Db, id: string): MonitorSnapshot | null {
  const monitor = getExtractionMonitor(db, id);
  if (!monitor) return null;
  const latestRow = db.prepare(
    `SELECT * FROM extraction_runs
     WHERE monitor_id = ? AND dry_run = 0 AND status != 'RUNNING'
     ORDER BY started_at DESC, rowid DESC LIMIT 1`,
  ).get(id) as RunRow | undefined;
  const fields: Record<string, ExtractedFieldResult> = {};
  if (latestRow) {
    const rows = db.prepare(
      "SELECT * FROM extracted_values WHERE run_id = ? ORDER BY field",
    ).all(latestRow.id) as ValueRow[];
    rows.forEach((row) => { fields[row.field] = fieldFromRow(row); });
  }
  return {
    monitor,
    latestRun: latestRow ? runFromRow(latestRow) : null,
    fields,
    recentRuns: runRows(db, id),
  };
}

export function listMonitorSnapshots(db: Db): MonitorSnapshot[] {
  return listExtractionMonitors(db)
    .map((monitor) => getMonitorSnapshot(db, monitor.id))
    .filter((snapshot): snapshot is MonitorSnapshot => snapshot !== null);
}
