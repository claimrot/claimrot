import type { Candidate } from "../model/types.js";

const BLOCK = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * schema.org / Open Graph fallback. Covers a surprising share of commerce pages.
 *
 * `field` is kept in the signature because callers pass it, but we do not branch
 * on it: real assertion fields look like `adult_price` / `child_price`, never the
 * bare literal "price", so gating on an exact string match made this fallback —
 * the one that serves the 352-host tail — return nothing on every real assertion.
 * Per spec §4.2, the field name is only a grouping hint; the anchor (label,
 * context) does the discriminating downstream. Emit every price candidate here
 * and let scoring reject the ones that aren't actually about this assertion.
 */
export function extractJsonLdCandidates(html: string, _field: string): Candidate[] {
  const out: Candidate[] = [];

  for (const m of html.matchAll(BLOCK)) {
    let data: any;
    try { data = JSON.parse(m[1]); } catch { continue; }

    // WordPress/Yoast and most CMSes wrap nodes in {"@graph": [...]}. Unwrap it
    // so those pages — common among our operator sites — aren't silently empty.
    const roots = Array.isArray(data) ? data : [data];
    const nodes = roots.flatMap((root) => (Array.isArray(root?.["@graph"]) ? root["@graph"] : [root]));

    for (const node of nodes) {
      const offers = node?.offers;
      for (const offer of Array.isArray(offers) ? offers : offers ? [offers] : []) {
        const raw = offer.price ?? offer.lowPrice;
        const value = raw === undefined ? null : Number(raw);
        if (value !== null && Number.isFinite(value)) {
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
