import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { checkAssertion } from "../../src/engine/check.js";
import type { EngineDeps } from "../../src/engine/check.js";
import { extractJsonLdCandidates } from "../../src/collect/generic.js";
import type { Assertion, Candidate } from "../../src/model/types.js";

const before = readFileSync("tests/fixtures/whalewatch-before.html", "utf8");
const after = readFileSync("tests/fixtures/whalewatch-after.html", "utf8");

const a: Assertion = {
  id: "a1", claimId: "c1", field: "price", op: "eq",
  valueNum: 175, valueText: null, valueMax: null, unit: "NZD", tolerance: null,
  anchorLabel: "Ocean Cabin", anchorContext: "Product", anchorPath: "jsonld>offers",
};

/**
 * TEST SCAFFOLDING ONLY — stands in for a healed collector's output. The
 * 2026 redesign moved the fares into `.fare-card` markup with no structured
 * data at all, so a real heal (Scraper Studio) would have to learn to read
 * this shape; a unit test can't run that, so this hand-scrapes the same
 * markup a healed collector would target. Not production code — do not
 * promote this into src/.
 */
function cardCandidates(html: string): Candidate[] {
  const out: Candidate[] = [];
  for (const block of html.split('<div class="fare-card"').slice(1)) {
    const title = /<h3 class="fare-card__title">([^<]+)<\/h3>/.exec(block)?.[1];
    const currency = /<span class="fare-card__price-currency">([^<]+)<\/span>/.exec(block)?.[1];
    const amount = /<strong class="fare-card__price-amount">([^<]+)<\/strong>/.exec(block)?.[1];
    if (!title || !amount) continue;
    const value = Number(amount);
    if (!Number.isFinite(value)) continue;
    out.push({
      value, valueText: null, unit: currency ?? null,
      label: title, context: "Product", path: "fare-cards>fare-card",
    });
  }
  return out;
}

describe("redesign survival", () => {
  it("HOLDS on the pre-redesign page with zero heal invocations", async () => {
    let heals = 0;
    const deps: EngineDeps = {
      run: async () => {
        const cands = extractJsonLdCandidates(before);
        return cands.length
          ? { status: "ok", record: { url: "u", fetchedAt: "t", collectorVersion: "v", pageSignature: "", fields: { price: cands } } }
          : { status: "empty", record: { url: "u", fetchedAt: "t", collectorVersion: "v", pageSignature: "", fields: {} } };
      },
      heal: async () => { heals++; return { status: "healed", collectorVersion: "v2", preview: {} }; },
    };
    const r = await checkAssertion(a, "generic", "https://x.example/p", deps);
    expect(r.verdict).toBe("HOLDS");
    expect(heals).toBe(0);
  });

  it("goes blind on a redesign, then recovers after a heal", async () => {
    // The redesign drops the schema.org block while the price stays visible.
    // The generic (JSON-LD-only) collector sees nothing on the "after" page
    // -> that is BLINDNESS, not absence, so the engine must heal rather than
    // report REMOVED. The healed collector is simulated here via
    // cardCandidates: a real Scraper Studio heal cannot run in a unit test.
    let runs = 0;
    const deps: EngineDeps = {
      run: async () => {
        runs++;
        const cands = runs === 1
          ? extractJsonLdCandidates(after)   // pre-heal: finds nothing
          : cardCandidates(after);                    // post-heal: reads the new markup
        return cands.length
          ? { status: "ok", record: { url: "u", fetchedAt: "t", collectorVersion: "v", pageSignature: "", fields: { price: cands } } }
          : { status: "empty", record: { url: "u", fetchedAt: "t", collectorVersion: "v", pageSignature: "", fields: {} } };
      },
      heal: async () => ({ status: "healed", collectorVersion: "v2", preview: {} }),
    };
    const r = await checkAssertion(a, "generic", "https://x.example/p", deps);
    expect(runs).toBe(2);                  // it actually went blind, healed, and re-ran
    expect(r.verdict).not.toBe("REMOVED"); // the value is still on the page
  });
});
