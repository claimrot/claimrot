import { describe, it, expect } from "vitest";
import { extractJsonLdCandidates } from "../../src/collect/generic.js";

const html = `<html><head>
<script type="application/ld+json">
{"@type":"Product","name":"Ocean Cabin","offers":{"@type":"Offer","price":"175","priceCurrency":"NZD"}}
</script></head><body></body></html>`;

describe("extractJsonLdCandidates", () => {
  it("reads price and currency out of a schema.org Offer", () => {
    const cands = extractJsonLdCandidates(html, "price");
    expect(cands).toHaveLength(1);
    expect(cands[0].value).toBe(175);
    expect(cands[0].unit).toBe("NZD");
    expect(cands[0].label).toBe("Ocean Cabin");
  });

  it("returns [] rather than throwing on malformed JSON-LD", () => {
    expect(extractJsonLdCandidates('<script type="application/ld+json">{oops</script>', "price")).toEqual([]);
  });
});
