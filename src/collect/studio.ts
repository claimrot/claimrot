import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Candidate } from "../model/types.js";
import {
  HEAL_PROMPT_MAX_CHARS,
  type CollectRunResult, type CollectorRecord, type Exec, type HealResult,
} from "./types.js";
import { parseRawValue } from "./parse.js";
import { tokenSet, isTokenSubset } from "../text.js";
import type { EngineDeps } from "../engine/check.js";

const pexec = promisify(execFile);

const defaultExec: Exec = async (args) => {
  try {
    const { stdout } = await pexec("npx", ["-p", "@brightdata/cli", "bdata", ...args], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? String(e), exitCode: e.code ?? 1 };
  }
};

/**
 * Collector field names are AI-authored per prompt, not fixed by us. Probe A
 * (2026-08-17) returned `price_value` / `currency` / `label` / `heading` and no
 * `path` at all. Map by synonym rather than assuming our own names.
 */
const SYNONYM = {
  value:   ["value", "price_value", "price", "amount"],
  unit:    ["unit", "currency", "price_currency"],
  label:   ["label", "name", "title"],
  context: ["context", "heading", "section", "category"],
  path:    ["path", "selector", "css_path"],
} as const;

const pick = (o: Record<string, unknown>, keys: readonly string[]): unknown =>
  keys.map((k) => o[k]).find((v) => v !== undefined && v !== null);

function toCandidate(c: Record<string, unknown>): Candidate {
  const raw = pick(c, SYNONYM.value);
  const { value, valueText } = parseRawValue(raw);
  return {
    value,
    valueText,
    unit: (pick(c, SYNONYM.unit) as string) ?? null,
    label: (pick(c, SYNONYM.label) as string) ?? "",
    context: (pick(c, SYNONYM.context) as string) ?? "",
    // Probe A: real collectors emit no path. Empty means "no evidence",
    // which scoring treats as an unavailable signal, not a mismatch.
    path: (pick(c, SYNONYM.path) as string) ?? "",
  };
}

/**
 * Probe A's real payload shape:
 *   [ { <collector-named field>: [ {...}, ... ], input: { url } } ]
 * The field name is the collector's choice, so treat ANY key whose value is an
 * array of objects as a candidate field, and ignore the `input` echo.
 */
function toRecord(raw: any, url: string): CollectorRecord {
  const fields: Record<string, Candidate[]> = {};
  const source = raw?.fields && typeof raw.fields === "object" ? raw.fields : raw;

  for (const [k, v] of Object.entries(source ?? {})) {
    if (k === "input") continue;
    const arr = Array.isArray(v) ? v : v && typeof v === "object" ? [v] : null;
    if (!arr || !arr.every((e) => e && typeof e === "object")) continue;
    // A candidate with no value, no valueText, AND no label carries nothing we
    // mapped from any SYNONYM — that's OUR parsing gap (an AI-authored
    // collector using field names outside our synonym lists), not a real
    // result. Drop it, and if that empties the field, omit the field entirely
    // so runCollector reports `empty` instead of a phantom `ok`.
    const usable = arr
      .map((c) => toCandidate(c as Record<string, unknown>))
      .filter((c) => c.value !== null || c.valueText !== null || c.label !== "");
    if (usable.length > 0) fields[k] = usable;
  }

  return {
    url: raw?.input?.url ?? raw?.url ?? url,
    fetchedAt: raw?.fetched_at ?? new Date().toISOString(),
    collectorVersion: raw?.collector_version ?? "unknown",
    pageSignature: raw?.page_signature ?? "",
    fields,
  };
}

export async function runCollector(
  collectorId: string, url: string, opts: { exec?: Exec } = {},
): Promise<CollectRunResult> {
  const exec = opts.exec ?? defaultExec;
  const { stdout, exitCode } = await exec(["scraper", "run", collectorId, url, "--json"]);
  if (exitCode !== 0) return { status: "error", error: stdout.slice(0, 2000) };

  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Unparseable output is a failure of OUR eyesight, never evidence of absence.
    return { status: "error", error: `unparseable collector output: ${stdout.slice(0, 500)}` };
  }

  const record = toRecord(Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed, url);
  const anyCandidates = Object.values(record.fields).some((cs) => cs.length > 0);
  return anyCandidates ? { status: "ok", record } : { status: "empty", record };
}

export async function healCollector(
  collectorId: string,
  prompt: string,
  opts: { url?: string; autoApprove?: boolean; exec?: Exec } = {},
): Promise<HealResult> {
  const exec = opts.exec ?? defaultExec;
  // Positional prompt, capped by the CLI.
  const args = ["scraper", "heal", collectorId, prompt.slice(0, HEAL_PROMPT_MAX_CHARS), "--json"];
  if (opts.url) args.push("--url", opts.url);
  // --auto-save matters: without it a healed template may not persist.
  if (opts.autoApprove) args.push("--auto-approve", "--auto-save");
  const { stdout, exitCode } = await exec(args);
  if (exitCode !== 0) return { status: "failed", error: stdout.slice(0, 2000) };

  try {
    const env = JSON.parse(stdout);
    const steps: string[] = env.completed_steps ?? [];

    // Probe C (2026-08-17): WITHOUT --auto-save the envelope still reports
    // status "done" while silently discarding the healed template. There is no
    // error and no distinct status — the ONLY signal is that completed_steps
    // omits "save_new_template". Trusting `status` here means every unattended
    // heal is thrown away and the next check goes blind again.
    if (env.status === "done") {
      if (!steps.includes("save_new_template")) {
        return {
          status: "failed",
          error: `heal reported "done" but completed_steps has no save_new_template — the template was NOT persisted (steps: ${steps.join(", ")})`,
        };
      }
      return { status: "healed", collectorVersion: env.collector_id ?? "unknown", preview: env.preview_result };
    }
    return { status: "awaiting_approval", preview: env.preview_result };
  } catch {
    return { status: "failed", error: `unparseable heal envelope: ${stdout.slice(0, 500)}` };
  }
}

/**
 * A candidate whose label matches SEVERAL distinct anchors is a collector
 * defect, not a match. Scoring cannot catch this — "Adult (16+)" and
 * "Adult Child Senior" are structurally identical against a one-token anchor —
 * so it is caught here, where the whole anchor set is visible.
 */
export function flagBlobCandidates(cands: Candidate[], anchorLabels: string[]): Candidate[] {
  return cands.filter((c) => {
    const labelTokens = tokenSet(c.label);
    const matched = anchorLabels
      .map((a) => tokenSet(a))
      .filter((at) => at.size > 0 && isTokenSubset(at, labelTokens));
    // Collapse a matched anchor into a larger matched anchor ONLY when that
    // larger anchor covers the whole candidate label. "Adult" folds into
    // "Adult (16+)" for label "Adult (16+)" — the larger anchor explains every
    // token. It must NOT fold into "Adult Child" for label "Adult Child
    // Senior", where "Senior" is left unexplained by any matched anchor and
    // the candidate is a genuine blob. (A collapse target that covers the
    // whole label is, by construction, equal to the label's own token set —
    // a plain subset relationship between two anchors is not enough, or
    // "Adult" would wrongly fold into "Adult Child" too.)
    const maximal = matched.filter((a) =>
      !matched.some((b) => b !== a && isTokenSubset(a, b) && isTokenSubset(labelTokens, b)),
    );
    return maximal.length <= 1;   // 0 or 1 distinct anchor is fine; 2+ is a blob
  });
}

/**
 * Wraps a raw collector run (whatever resolves collectorId+url to a
 * CollectRunResult — a Bright Data run, the generic JSON-LD fetch, or a test
 * fake) so every "ok" record is screened through flagBlobCandidates before
 * the engine ever sees it, using the FULL anchor set for that source URL —
 * flagBlobCandidates needs more than the one assertion checkAssertion sees at
 * a time. A field emptied entirely by screening reports "empty", which
 * correctly routes to heal rather than a false verdict. Shared by src/cli.ts
 * (which additionally routes the "generic" collector ID to a direct fetch)
 * and examples/produce-output.ts (which always targets one real collector).
 */
export function withBlobScreening(
  run: (collectorId: string, url: string) => Promise<CollectRunResult>,
  anchors: string[],
): EngineDeps["run"] {
  return async (collectorId, url) => {
    const result = await run(collectorId, url);
    if (result.status !== "ok") return result;

    const fields: Record<string, Candidate[]> = {};
    for (const [k, v] of Object.entries(result.record.fields)) {
      const kept = flagBlobCandidates(v, anchors);
      if (kept.length > 0) fields[k] = kept;
    }
    const record = { ...result.record, fields };
    return Object.keys(fields).length > 0
      ? { status: "ok" as const, record }
      : { status: "empty" as const, record };
  };
}
