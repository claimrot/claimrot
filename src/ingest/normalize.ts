import { z } from "zod";
import type { Assertion } from "../model/types.js";

/**
 * `.strict()` on both objects, to match `additionalProperties: false` in the
 * JSON Schema below. Zod's default is to STRIP unknown keys and succeed, which
 * would have let a backend return a field we never asked for and have it
 * silently vanish — the two declarations must reject the same things or the
 * model is being constrained by one and judged by the other.
 */
export const NormalizedSchema = z.object({
  assertions: z.array(z.object({
    field: z.string(),
    op: z.enum(["eq", "approx", "range", "contains", "exists"]),
    valueNum: z.number().nullable(),
    valueText: z.string().nullable(),
    valueMax: z.number().nullable(),
    unit: z.string().nullable(),
    tolerance: z.number().nullable(),
    anchorLabel: z.string(),
    anchorContext: z.string(),
  }).strict()),
}).strict();

/**
 * The same contract as `NormalizedSchema`, as JSON Schema, because all three
 * backends want it in that form: the API takes it as
 * `output_format: {type: "json_schema"}`, `claude --json-schema` takes it
 * inline, and `codex exec --output-schema` takes it as a file.
 *
 * It is written out rather than derived because the SDK's `betaZodOutputFormat`
 * helper calls `z.toJSONSchema()`, which only exists in zod 4 — this project is
 * on zod 3, so that helper throws before it ever reaches the network. Two
 * declarations of one contract can drift, so `tests/ingest/schema.test.ts`
 * feeds fixtures to both and asserts they accept and reject exactly the same
 * things.
 */
export const ASSERTIONS_JSON_SCHEMA = {
  type: "object",
  required: ["assertions"],
  additionalProperties: false,
  properties: {
    assertions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "field", "op", "valueNum", "valueText", "valueMax",
          "unit", "tolerance", "anchorLabel", "anchorContext",
        ],
        properties: {
          field: { type: "string" },
          op: { type: "string", enum: ["eq", "approx", "range", "contains", "exists"] },
          valueNum: { type: ["number", "null"] },
          valueText: { type: ["string", "null"] },
          valueMax: { type: ["number", "null"] },
          unit: { type: ["string", "null"] },
          tolerance: { type: ["number", "null"] },
          anchorLabel: { type: "string" },
          anchorContext: { type: "string" },
        },
      },
    },
  },
} as const;

export type ParseFn = (text: string) => Promise<unknown>;

export const SYSTEM = `You reduce a prose claim about a web page into structured, machine-testable assertions.

Return one assertion per independently checkable value. Prefer few, high-quality assertions
over many marginal ones.

anchorLabel is the label on the page that GOVERNS the value — "Adult", "Child (3-15)",
"Ocean Cabin". It is what a checker will search for later. Never put the value itself in
anchorLabel. anchorContext is the enclosing heading, table caption, or section that
disambiguates the label when the same label appears more than once.

Choose the operator honestly:
  eq       an exact published figure or string
  approx   a figure the source rounds or varies ("about 2 hours") — set tolerance
  range    an explicit band — set valueNum (low) and valueMax (high)
  contains a substring that must still appear
  exists   the value must be published at all, whatever it says

If a claim carries no testable value — an impression, an opinion, a description with no
figure or named policy — return an empty assertions array. That is a correct answer, and
far better than inventing something checkable. Do not guess.

## Anchors, specifically

anchorLabel must be text a reader would actually find on the page, sitting next to and
governing the value — never the value itself, and never a paraphrase invented for
convenience. If you cannot name a label that would appear on the page, you cannot write
the assertion.

anchorContext is not optional decoration. A label alone is rarely enough to find one value
among several on a real page — "Adult" appears in a pricing table, a group-size table, and
a terms section. anchorContext names the surrounding structure (the tour name, the table
caption, the section heading) that tells a checker which "Adult" this is. An assertion with
a label but no disambiguating context is not useful: it cannot be matched with confidence
later, so do not emit one.

## Worked examples

Example 1 — testable, and with more than one value to track:
Claim: "Whale Watch's Ocean Cabin tour is NZ$175 per adult, and NZ$185 from 1 October 2026."
This page publishes two adult prices that a checker must be able to tell apart, so it is
two assertions, not one:
  { field: "adult_price", op: "eq", valueNum: 175, unit: "NZD",
    anchorLabel: "Adult", anchorContext: "Ocean Cabin" }
  { field: "adult_price_from_2026-10-01", op: "eq", valueNum: 185, unit: "NZD",
    anchorLabel: "Adult", anchorContext: "Ocean Cabin, from 1 October 2026" }
Both assertions reuse the label "Adult" because that is the literal text on the page; the
context is what separates the current figure from the future one.

Example 2 — untestable:
Claim: "The harbour is a pleasant place to spend an afternoon."
There is no figure, no named policy, nothing a page could publish that a scraper could
later confirm or refute. This is an opinion about the experience, not a fact about the
page. Correct output: { assertions: [] }.

## Operator pages

Tour, ticket, and rental operator pages commonly publish more than one variant of what
looks like a single price or duration: current vs. future, adult vs. concession, weekday
vs. weekend, peak vs. off-peak. Do not collapse these into one assertion. Each distinct
governing label — each row of a pricing table, each named tier — is its own assertion with
its own anchorContext, even when several of them share the same anchorLabel text.`;

/**
 * `parse` is required rather than defaulted. The default used to be a live API
 * call, which meant every caller silently depended on a credential and on the
 * one code path no test exercises — and that path was broken from the start
 * (see ASSERTIONS_JSON_SCHEMA). Backends now live in ./backends.ts and the
 * caller chooses one, so "which model did this" is answered at the call site.
 */
export async function normalizeClaim(
  text: string, claimId: string, deps: { parse: ParseFn },
): Promise<Assertion[]> {
  const raw = await deps.parse(text);
  const parsed = NormalizedSchema.safeParse(raw);
  if (!parsed.success) return [];

  return parsed.data.assertions
    .map((a, i): Assertion => ({
      id: `${claimId}:a${i}`,
      claimId,
      field: a.field,
      op: a.op,
      valueNum: a.valueNum,
      valueText: a.valueText,
      valueMax: a.valueMax,
      unit: a.unit,
      tolerance: a.tolerance,
      anchorLabel: a.anchorLabel,
      anchorContext: a.anchorContext,
      anchorPath: "",  // recorded on the first successful check
    }))
    // The scoring floor needs a real label anchor plus >=0.5 of the weight budget.
    // A context-less anchor against a real collector (no unit, no path) totals 0.40,
    // scores zero, and heals forever without ever returning a verdict. Refuse it here,
    // where the anchor is authored — the adapter downstream cannot invent context the
    // page never published.
    .filter((a) => a.anchorLabel.trim() !== "" && a.anchorContext.trim() !== "");
}
