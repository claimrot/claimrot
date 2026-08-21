import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Candidate } from "../model/types.js";
import type { CollectorRecord, CollectRunResult, HealResult } from "../collect/types.js";
import { runGenericFields } from "../collect/generic.js";
import { isGenericCollector } from "../collect/registry.js";
import { healCollector, runCollector } from "../collect/studio.js";
import { HostQueue, isAllowed } from "../net/politeness.js";
import { fetchRobots } from "../net/robots.js";
import type { ExtractionField, ExtractionFieldType } from "./schema.js";
import {
  finishExtractionRun, getExtractionMonitor, getMonitorSnapshot,
  insertExtractedFields, insertExtractionRun,
} from "./store.js";
import type {
  ExtractedFieldResult, ExtractionHealStatus, ExtractionOutcome, ExtractionRunStatus,
} from "./types.js";

type Db = Database.Database;

export interface ExtractionServiceDeps {
  now?: () => Date;
  queue?: Pick<HostQueue, "run">;
  fetchRobots?: (host: string) => Promise<string>;
  run?: (
    collectorId: string,
    url: string,
    fields: Array<{ name: string; type: ExtractionFieldType }>,
  ) => Promise<CollectRunResult>;
  heal?: (collectorId: string, prompt: string, url: string) => Promise<HealResult>;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function tokens(value: string): Set<string> {
  return new Set(normalized(value).split("_").filter(Boolean));
}

function supportsType(candidate: Candidate, type: ExtractionFieldType): boolean {
  if (type === "number" || type === "money") return candidate.value !== null;
  return candidate.valueText !== null && candidate.valueText.trim() !== "";
}

function candidatePools(
  record: CollectorRecord,
  fieldName: string,
): Array<{ candidates: Candidate[]; confidence: number; keys: string[] }> {
  const entries = Object.entries(record.fields);
  const wanted = normalized(fieldName);
  const exact = entries.filter(([key]) => normalized(key) === wanted);
  const wantedTokens = tokens(fieldName);
  const related = entries.filter(([key]) => {
    if (normalized(key) === wanted) return false;
    return [...tokens(key)].some((token) => wantedTokens.has(token));
  });
  const pools: Array<{ candidates: Candidate[]; confidence: number; keys: string[] }> = [];
  if (exact.length) pools.push({
    candidates: exact.flatMap(([, candidates]) => candidates),
    confidence: 0.98,
    keys: exact.map(([key]) => key),
  });
  if (related.length) pools.push({
    candidates: related.flatMap(([, candidates]) => candidates),
    confidence: 0.85,
    keys: related.map(([key]) => key),
  });
  if (entries.length === 1 && exact.length === 0 && related.length === 0) pools.push({
    candidates: entries[0][1], confidence: 0.65, keys: [entries[0][0]],
  });
  return pools;
}

function emptyField(
  name: string,
  definition: ExtractionField,
  status: "MISSING" | "ERROR" = "MISSING",
  error: string | null = null,
): ExtractedFieldResult {
  return {
    field: name,
    type: definition.type,
    status,
    value: null,
    valueNum: null,
    valueText: null,
    unit: null,
    label: "",
    context: "",
    path: "",
    confidence: 0,
    error,
    evidence: [],
  };
}

export function resolveExtractedField(
  record: CollectorRecord,
  name: string,
  definition: ExtractionField,
): ExtractedFieldResult {
  for (const pool of candidatePools(record, name)) {
    const usable = pool.candidates.filter((candidate) => supportsType(candidate, definition.type));
    if (!usable.length) continue;
    const distinct = new Map<string, Candidate>();
    usable.forEach((candidate) => {
      const value = candidate.value ?? candidate.valueText;
      distinct.set(`${String(value)}\u0000${candidate.unit ?? ""}`, candidate);
    });
    const chosen = usable[0];
    const ambiguous = distinct.size > 1;
    return {
      field: name,
      type: definition.type,
      status: ambiguous ? "AMBIGUOUS" : "OK",
      value: chosen.value ?? chosen.valueText,
      valueNum: chosen.value,
      valueText: chosen.valueText,
      unit: chosen.unit,
      label: chosen.label,
      context: chosen.context,
      path: chosen.path,
      confidence: ambiguous ? Math.min(pool.confidence, 0.6) : pool.confidence,
      error: ambiguous ? `${distinct.size} distinct values were extracted` : null,
      evidence: { keys: pool.keys, candidates: usable },
    };
  }
  return emptyField(name, definition);
}

function resolveFields(
  record: CollectorRecord,
  definitions: Record<string, ExtractionField>,
): Record<string, ExtractedFieldResult> {
  return Object.fromEntries(Object.entries(definitions)
    .map(([name, definition]) => [name, resolveExtractedField(record, name, definition)]));
}

function healPrompt(
  fields: Array<[string, ExtractionField]>,
): string {
  const descriptions = fields.map(([name, field]) =>
    `"${name}" (${field.type}): ${field.description}`).join("; ");
  return [
    "The scraper ran successfully but did not return every requested product field.",
    `Extract these fields: ${descriptions}.`,
    "Return each field with its value plus the nearest label, enclosing context, unit, and path.",
  ].join(" ").slice(0, 1000);
}

function runStatus(fields: Record<string, ExtractedFieldResult>): ExtractionRunStatus {
  const values = Object.values(fields);
  const ok = values.filter((field) => field.status === "OK").length;
  const useful = values.filter((field) => field.status === "OK" || field.status === "AMBIGUOUS").length;
  if (ok === values.length) return "SUCCEEDED";
  if (useful > 0) return "PARTIAL";
  return "FAILED";
}

function nextDate(completedAt: string, intervalDays: number): string {
  return new Date(new Date(completedAt).getTime() + intervalDays * 86_400_000).toISOString();
}

function defaultRun(
  collectorId: string,
  url: string,
  fields: Array<{ name: string; type: ExtractionFieldType }>,
): Promise<CollectRunResult> {
  return isGenericCollector(collectorId)
    ? runGenericFields(url, fields)
    : runCollector(collectorId, url);
}

export async function executeExtraction(
  db: Db,
  monitorId: string,
  options: { force?: boolean; dryRun?: boolean } = {},
  deps: ExtractionServiceDeps = {},
): Promise<ExtractionOutcome> {
  const monitor = getExtractionMonitor(db, monitorId);
  if (!monitor) throw new Error(`Unknown extraction monitor: ${monitorId}`);
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const dryRun = Boolean(options.dryRun);
  if (!options.force && !dryRun && monitor.nextRunAt && monitor.nextRunAt > startedAt) {
    const current = getMonitorSnapshot(db, monitorId);
    return {
      monitorId,
      url: monitor.sourceUrl,
      runId: null,
      status: "SKIPPED",
      dryRun: false,
      scrapedAt: current?.latestRun?.completedAt ?? null,
      nextRunAt: monitor.nextRunAt,
      collectorId: monitor.collectorId,
      collectorVersion: current?.latestRun?.collectorVersion ?? null,
      healStatus: "NOT_NEEDED",
      error: `not due until ${monitor.nextRunAt}`,
      fields: current?.fields ?? {},
    };
  }

  const runId = randomUUID();
  insertExtractionRun(db, {
    id: runId,
    monitorId,
    startedAt,
    dryRun,
    collectorId: monitor.collectorId,
  });
  const queue = deps.queue ?? new HostQueue();
  const robots = deps.fetchRobots ?? fetchRobots;
  const run = deps.run ?? defaultRun;
  const heal = deps.heal ?? ((collectorId, prompt, url) =>
    healCollector(collectorId, prompt, { url, autoApprove: true }));
  const definitions = monitor.definition.fields;
  const fieldRequests = Object.entries(definitions)
    .map(([name, field]) => ({ name, type: field.type }));
  const parsed = new URL(monitor.sourceUrl);
  const robotsText = await queue.run(
    `${parsed.protocol}//${parsed.host}/robots.txt`,
    () => robots(parsed.host),
  );

  let status: ExtractionRunStatus;
  let healStatus: ExtractionHealStatus = "NOT_NEEDED";
  let collectorVersion: string | null = null;
  let error: string | null = null;
  let fields: Record<string, ExtractedFieldResult>;

  if (!isAllowed(robotsText, parsed.pathname || "/")) {
    status = "BLOCKED";
    error = "robots.txt disallows this URL";
    fields = Object.fromEntries(Object.entries(definitions)
      .map(([name, definition]) => [name, emptyField(name, definition, "ERROR", error)]));
  } else {
    const first = await queue.run(monitor.sourceUrl, () =>
      run(monitor.collectorId, monitor.sourceUrl, fieldRequests));
    if (first.status === "error") {
      status = "FAILED";
      error = first.error;
      fields = Object.fromEntries(Object.entries(definitions)
        .map(([name, definition]) => [name, emptyField(name, definition, "ERROR", error)]));
    } else {
      collectorVersion = first.record.collectorVersion;
      fields = resolveFields(first.record, definitions);
      const missing = Object.entries(fields)
        .filter(([, field]) => field.status === "MISSING")
        .map(([name]) => [name, definitions[name]] as [string, ExtractionField]);
      if (missing.length > 0 && isGenericCollector(monitor.collectorId)) {
        healStatus = "UNAVAILABLE";
        missing.forEach(([name]) => {
          fields[name].error = "No Bright Data collector is registered for this host; automatic healing is unavailable.";
        });
      } else if (missing.length > 0) {
        const healed = await heal(monitor.collectorId, healPrompt(missing), monitor.sourceUrl);
        if (healed.status === "healed") {
          healStatus = "SUCCEEDED";
          collectorVersion = healed.collectorVersion;
          const second = await queue.run(monitor.sourceUrl, () =>
            run(monitor.collectorId, monitor.sourceUrl, fieldRequests));
          if (second.status === "ok") {
            collectorVersion = second.record.collectorVersion || collectorVersion;
            fields = resolveFields(second.record, definitions);
          } else {
            error = second.status === "error" ? second.error : "collector remained empty after healing";
            missing.forEach(([name]) => { fields[name].error = error; });
          }
        } else if (healed.status === "awaiting_approval") {
          healStatus = "AWAITING_APPROVAL";
          error = "collector healing is awaiting approval";
          missing.forEach(([name]) => { fields[name].error = error; });
        } else {
          healStatus = "FAILED";
          error = healed.error;
          missing.forEach(([name]) => { fields[name].error = `heal failed: ${error}`; });
        }
      }
      status = runStatus(fields);
    }
  }

  const completedAt = now().toISOString();
  const nextRunAt = dryRun ? monitor.nextRunAt : nextDate(completedAt, monitor.intervalDays);
  insertExtractedFields(db, {
    runId,
    monitorId,
    scrapedAt: completedAt,
    fields: Object.values(fields),
  });
  finishExtractionRun(db, {
    id: runId,
    monitorId,
    completedAt,
    status,
    collectorVersion,
    healStatus,
    error,
    dryRun,
    nextRunAt,
  });
  return {
    monitorId,
    url: monitor.sourceUrl,
    runId,
    status,
    dryRun,
    scrapedAt: completedAt,
    nextRunAt,
    collectorId: monitor.collectorId,
    collectorVersion,
    healStatus,
    error,
    fields,
  };
}
