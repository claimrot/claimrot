import { describe, it, expect } from "vitest";
import { extractJsonLdCandidates } from "../../src/collect/generic.js";

const html = `<html><head>
<script type="application/ld+json">
{"@type":"Product","name":"Ocean Cabin","offers":{"@type":"Offer","price":"175","priceCurrency":"NZD"}}
</script></head><body></body></html>`;

describe("extractJsonLdCandidates", () => {
  it("reads price and currency out of a schema.org Offer", () => {
    const cands = extractJsonLdCandidates(html);
    expect(cands).toHaveLength(1);
    expect(cands[0].value).toBe(175);
    expect(cands[0].unit).toBe("NZD");
    expect(cands[0].label).toBe("Ocean Cabin");
  });

  it("returns [] rather than throwing on malformed JSON-LD", () => {
    expect(extractJsonLdCandidates('<script type="application/ld+json">{oops</script>')).toEqual([]);
  });

  it("emits candidates for a price-like field name, not only the literal 'price'", () => {
    // Real assertion fields are adult_price / child_price, never bare "price".
    // Gating on the exact string made the generic fallback — the collector that
    // serves the 352-host tail — return nothing on every real assertion.
    const cands = extractJsonLdCandidates(html);
    expect(cands).toHaveLength(1);
    expect(cands[0].value).toBe(175);
  });

  it("unwraps @graph-wrapped JSON-LD (Yoast/WordPress)", () => {
    const graphHtml = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Ocean Cabin","offers":{"@type":"Offer","price":"175","priceCurrency":"NZD"}}]}
</script></head><body></body></html>`;
    const cands = extractJsonLdCandidates(graphHtml);
    expect(cands).toHaveLength(1);
    expect(cands[0].value).toBe(175);
    expect(cands[0].unit).toBe("NZD");
    expect(cands[0].label).toBe("Ocean Cabin");
  });
});
