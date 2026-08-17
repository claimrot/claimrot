import type { Candidate } from "../model/types.js";
import type { CollectorRecord, CollectRunResult } from "./types.js";
import { parseRawValue } from "./parse.js";
import { GENERIC_COLLECTOR_ID } from "./registry.js";
import { ROBOTS_UA } from "../net/politeness.js";

const BLOCK = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// A hung fetch must not stall this host's whole queue.
const GENERIC_FETCH_TIMEOUT_MS = 20_000;

/**
 * schema.org / Open Graph fallback. Covers a surprising share of commerce pages.
 *
 * Real assertion fields look like `adult_price` / `child_price`, never the
 * bare literal "price", so this does not gate on the field it was asked
 * about — per spec §4.2 the field name is only a grouping hint; the anchor
 * (label, context) does the discriminating downstream. It emits every price
 * candidate found on the page and lets scoring reject the ones that aren't
 * actually about this assertion.
 */
export function extractJsonLdCandidates(html: string): Candidate[] {
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
        // Blank/whitespace ("") must not become 0, and a currency-formatted
        // string ("NZ$175.00") must still parse — see src/collect/parse.ts.
        const { value } = parseRawValue(raw);
        if (value !== null) {
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

/**
 * The unmatched tail (46 of our hosts appear exactly once, design doc §9) has
 * no bespoke collector, so this fetches the page directly and reads
 * schema.org JSON-LD (spec §7: this is the collector that heals most often,
 * precisely because it is the least specific).
 *
 * A fetch failure or non-2xx response must report `error`, never `empty` —
 * `empty` feeds the engine's blindness/heal/REMOVED path, and a network blip
 * is OUR eyesight failing, never evidence that the page's value is gone.
 * `fetchImpl` defaults to global fetch and exists purely so a test can inject
 * a fake, the same pattern src/cli.ts's fetchRobots and collect/studio.ts's
 * `Exec` use.
 */
export async function runGeneric(
  url: string, field: string, fetchImpl: typeof fetch = fetch,
): Promise<CollectRunResult> {
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": ROBOTS_UA },
      signal: AbortSignal.timeout(GENERIC_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { status: "error", error: `HTTP ${res.status}` };

    const candidates = extractJsonLdCandidates(await res.text());
    const record: CollectorRecord = {
      url, fetchedAt: new Date().toISOString(), collectorVersion: GENERIC_COLLECTOR_ID,
      pageSignature: "", fields: candidates.length ? { [field]: candidates } : {},
    };
    return candidates.length ? { status: "ok", record } : { status: "empty", record };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
