import type { ExtractionDefinition, ExtractionFieldType } from "./schema.js";

export type ExtractionRunStatus =
  | "RUNNING"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED"
  | "BLOCKED"
  | "SKIPPED";

export type ExtractionFieldStatus = "OK" | "AMBIGUOUS" | "MISSING" | "ERROR";
export type ExtractionHealStatus =
  | "NOT_NEEDED"
  | "UNAVAILABLE"
  | "SUCCEEDED"
  | "FAILED"
  | "AWAITING_APPROVAL";

export interface ExtractionMonitor {
  id: string;
  sourceUrl: string;
  definition: ExtractionDefinition;
  intervalDays: number;
  collectorId: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: ExtractionRunStatus | null;
}

export interface ExtractedFieldResult {
  field: string;
  type: ExtractionFieldType;
  status: ExtractionFieldStatus;
  value: string | number | null;
  valueNum: number | null;
  valueText: string | null;
  unit: string | null;
  label: string;
  context: string;
  path: string;
  confidence: number;
  error: string | null;
  evidence: unknown;
}

export interface ExtractionOutcome {
  monitorId: string;
  url: string;
  runId: string | null;
  status: ExtractionRunStatus;
  dryRun: boolean;
  scrapedAt: string | null;
  nextRunAt: string | null;
  collectorId: string;
  collectorVersion: string | null;
  healStatus: ExtractionHealStatus;
  error: string | null;
  fields: Record<string, ExtractedFieldResult>;
}

export interface ExtractionRunSummary {
  id: string;
  monitorId: string;
  startedAt: string;
  completedAt: string | null;
  status: ExtractionRunStatus;
  dryRun: boolean;
  collectorId: string;
  collectorVersion: string | null;
  healStatus: ExtractionHealStatus;
  error: string | null;
}

export interface MonitorSnapshot {
  monitor: ExtractionMonitor;
  latestRun: ExtractionRunSummary | null;
  fields: Record<string, ExtractedFieldResult>;
  recentRuns: ExtractionRunSummary[];
}
