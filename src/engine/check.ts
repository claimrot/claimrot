import type { Assertion, Candidate, Resolution } from "../model/types.js";
import {
  HEAL_PROMPT_MAX_CHARS,
  type CollectorRecord, type CollectRunResult, type HealResult,
} from "../collect/types.js";
import { resolveCandidates } from "../resolve/resolve.js";
import { tokenSet } from "../text.js";

export interface EngineDeps {
  run: (collectorId: string, url: string) => Promise<CollectRunResult>;
  /** prompt describes WHAT WE WENT BLIND TO; the CLI anchors heals on prose, not URLs. */
  heal: (collectorId: string, prompt: string, url: string) => Promise<HealResult>;
}

const unverifiable = (reason: string): Resolution =>
  ({ verdict: "UNVERIFIABLE", confidence: 0, chosen: null, contenders: [], reason });

// A healed collector that still finds nothing is strong evidence of removal,
// but not certain — the heal could itself have mis-targeted the anchor — so
// this stays short of full confidence.
const REMOVED_AFTER_HEAL_CONFIDENCE = 0.8;

// naive singularise, layered on top of the shared tokenizer
const normTokens = (s: string) =>
  new Set([...tokenSet(s)].map((t) => t.replace(/ies$/, "y").replace(/s$/, "")));

/**
 * Collector field names are AI-authored per prompt (collect/studio.ts's
 * SYNONYM comment), so a field name on a record cannot be trusted as a
 * stable identifier for "the field we asked about" — but it is still WEAK
 * EVIDENCE, and discarding it entirely let an "Adult"-labelled duration
 * outscore a price assertion. Exact key first, then fields whose name shares
 * a token with ours, and only then everything — so an unrelated field
 * competes solely when nothing else can.
 *
 * If a future adapter ever emitted an empty exact-key field alongside a
 * differently-named one holding the real candidates (e.g.
 * `{adult_price: [], prices: [...]}`), the `exact.length > 0` check falls
 * through to the related/flatten tiers below — unreachable today because
 * `toRecord` omits empty fields entirely, and even if it happened it can only
 * over-collect candidates, never manufacture a false REMOVED.
 */
function candidatesFor(record: CollectorRecord, field: string): Candidate[] {
  const exact = record.fields[field];
  if (exact && exact.length > 0) return exact;

  const want = normTokens(field);
  const related = Object.entries(record.fields)
    .filter(([k]) => [...normTokens(k)].some((t) => want.has(t)))
    .flatMap(([, v]) => v);
  if (related.length > 0) return related;

  return Object.values(record.fields).flat();
}

/**
 * The heal prompt. We know precisely what we stopped being able to see, so we
 * say so — a description of the missing anchor heals far better than a bare URL,
 * and the CLI takes prose anyway.
 */
export function healPrompt(a: Assertion): string {
  const contextClause = a.anchorContext ? ` within "${a.anchorContext}"` : "";
  return [
    `The scraper returned no candidate for the field "${a.field}".`,
    `It should extract every value on the page together with the label that governs it.`,
    `Specifically, it must find the value labelled "${a.anchorLabel}"${contextClause}.`,
    `Return each candidate with its value, unit, governing label, and enclosing heading.`,
  ].join(" ").slice(0, HEAL_PROMPT_MAX_CHARS);
}

/**
 * Three branches (spec §4.5):
 *   extracted + matches   -> HOLDS
 *   extracted + differs   -> DRIFTED
 *   extracted nothing     -> heal, and only a HEALED collector that still sees
 *                            nothing may say REMOVED
 *
 * Heal fires on BLINDNESS, never on CHANGE. A changed value is a finding; a
 * missing value is a question about our own eyesight.
 */
export async function checkAssertion(
  a: Assertion, collectorId: string, url: string, deps: EngineDeps,
): Promise<Resolution> {
  const first = await deps.run(collectorId, url);

  if (first.status === "ok") {
    const resolved = resolveCandidates(a, candidatesFor(first.record, a.field));
    if (resolved) return resolved;
    // Ran fine but nothing anchored well enough — still blindness.
  }

  const heal = await deps.heal(collectorId, healPrompt(a), url);
  if (heal.status === "failed") return unverifiable(`heal failed: ${heal.error}`);
  if (heal.status === "awaiting_approval") {
    return unverifiable("heal is awaiting approval; no conclusion may be drawn yet");
  }

  const second = await deps.run(collectorId, url);
  if (second.status === "error") return unverifiable(`post-heal run failed: ${second.error}`);

  const resolved = resolveCandidates(a, candidatesFor(second.record, a.field));
  if (resolved) return resolved;

  return {
    verdict: "REMOVED",
    confidence: REMOVED_AFTER_HEAL_CONFIDENCE,
    chosen: null,
    contenders: [],
    reason: `a healed collector (${heal.collectorVersion}) still finds no candidate anchored to "${a.anchorLabel}"`,
  };
}
