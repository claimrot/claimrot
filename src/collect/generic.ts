import type { Candidate } from "../model/types.js";

const BLOCK = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** schema.org / Open Graph fallback. Covers a surprising share of commerce pages. */
export function extractJsonLdCandidates(html: string, field: string): Candidate[] {
  const out: Candidate[] = [];

  for (const m of html.matchAll(BLOCK)) {
    let data: any;
    try { data = JSON.parse(m[1]); } catch { continue; }

    for (const node of Array.isArray(data) ? data : [data]) {
      const offers = node?.offers;
      for (const offer of Array.isArray(offers) ? offers : offers ? [offers] : []) {
        const raw = offer.price ?? offer.lowPrice;
        const value = raw === undefined ? null : Number(raw);
        if (field === "price" && value !== null && Number.isFinite(value)) {
          out.push({
            value,
            valueText: null,
            unit: offer.priceCurrency ?? null,
            label: node.name ?? "",
            context: node["@type"] ?? "",
            path: "jsonld>offers",
          });
        }
      }
    }
  }
  return out;
}
