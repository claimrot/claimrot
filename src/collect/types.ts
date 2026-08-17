import type { Candidate } from "../model/types.js";

/**
 * Positional heal-prompt cap enforced by the Bright Data CLI. Applied both
 * where the prompt is composed (engine/check.ts's healPrompt) and where it is
 * actually passed as an argv positional (collect/studio.ts's healCollector) —
 * named once here so the two can't drift to different numbers.
 */
export const HEAL_PROMPT_MAX_CHARS = 1000;

export interface CollectorRecord {
  url: string;
  fetchedAt: string;
  collectorVersion: string;
  pageSignature: string;
  fields: Record<string, Candidate[]>;
}

export type CollectRunResult =
  | { status: "ok"; record: CollectorRecord }
  | { status: "empty"; record: CollectorRecord }  // ran fine, no candidates for the field
  | { status: "error"; error: string };

export type HealResult =
  | { status: "healed"; collectorVersion: string; preview: unknown }
  | { status: "awaiting_approval"; preview: unknown }
  | { status: "failed"; error: string };

export type Exec = (args: string[]) => Promise<{ stdout: string; exitCode: number }>;
