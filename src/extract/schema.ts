import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

export const ExtractionFieldTypeSchema = z.enum(["string", "text", "number", "money"]);
export type ExtractionFieldType = z.infer<typeof ExtractionFieldTypeSchema>;

export const ExtractionFieldSchema = z.object({
  type: ExtractionFieldTypeSchema,
  description: z.string().trim().min(1),
}).strict();

export const ExtractionSchema = z.object({
  fields: z.record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
    ExtractionFieldSchema,
  ).refine((fields) => Object.keys(fields).length > 0, "at least one field is required"),
  intervalDays: z.number().int().positive().max(365).optional(),
}).strict();

export type ExtractionField = z.infer<typeof ExtractionFieldSchema>;
export type ExtractionDefinition = z.infer<typeof ExtractionSchema>;

export function readExtractionSchema(path: string): ExtractionDefinition {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read extraction schema ${path}: ${message}`);
  }
  const parsed = ExtractionSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid extraction schema ${path}: ${parsed.error.issues.map((issue) =>
      `${issue.path.join(".") || "schema"}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function monitorIdFor(url: string): string {
  const parsed = new URL(url);
  const base = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 54) || "monitor";
  const suffix = createHash("sha256").update(parsed.href).digest("hex").slice(0, 8);
  return `${base}-${suffix}`;
}

export function parseIntervalDays(value: string): number {
  const days = Number(value);
  if (!Number.isInteger(days) || days <= 0 || days > 365) {
    throw new Error("interval must be a whole number from 1 to 365 days");
  }
  return days;
}
