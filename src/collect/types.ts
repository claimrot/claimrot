import type { Candidate } from "../model/types.js";

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
