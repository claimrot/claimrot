import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Assertion } from "../model/types.js";

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
  })),
});

export type ParseFn = (text: string) => Promise<unknown>;

const SYSTEM = `You reduce a prose claim about a web page into structured, machine-testable assertions.

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
far better than inventing something checkable. Do not guess.`;

async function liveParse(text: string): Promise<unknown> {
  const client = new Anthropic();
  const response = await client.beta.messages.parse({
    model: "claude-opus-5",
    max_tokens: 4096,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_format: betaZodOutputFormat(NormalizedSchema),
    messages: [{ role: "user", content: `Claim:\n${text}` }],
  });
  return response.parsed_output;
}

export async function normalizeClaim(
  text: string, claimId: string, deps: { parse?: ParseFn } = {},
): Promise<Assertion[]> {
  const raw = await (deps.parse ?? liveParse)(text);
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
