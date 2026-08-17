import type { Assertion, Candidate, Resolution } from "../model/types.js";
import type { CollectorRecord, CollectRunResult, HealResult } from "../collect/types.js";
import { resolveCandidates } from "../resolve/resolve.js";

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

/**
 * The collector names its own fields (probe A returned "prices"; our assertion
 * says "adult_price"), so a key lookup cannot be the identifier. Spec 4.2 is
 * explicit that the ANCHOR identifies the value — the field name is only a
 * grouping hint. Prefer an exact key when one exists, otherwise consider every
 * candidate the collector returned and let the anchor pick the winner.
 */
function candidatesFor(record: CollectorRecord, field: string): Candidate[] {
  const exact = record.fields[field];
  if (exact && exact.length > 0) return exact;
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
  ].join(" ").slice(0, 1000);
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
