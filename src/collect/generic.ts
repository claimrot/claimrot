import type { Candidate } from "../model/types.js";
import type { CollectorRecord, CollectRunResult } from "./types.js";
import { parseRawValue } from "./parse.js";
import { GENERIC_COLLECTOR_ID } from "./registry.js";
import { ROBOTS_UA } from "../net/politeness.js";

const BLOCK = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// A hung fetch must not stall this host's whole queue.
const GENERIC_FETCH_TIMEOUT_MS = 20_000;

export type GenericFieldRequest = {
  name: string;
  type: "string" | "text" | "number" | "money";
};

function jsonLdNodes(html: string): any[] {
  const nodes: any[] = [];
  for (const match of html.matchAll(BLOCK)) {
    let data: any;
    try { data = JSON.parse(match[1]); } catch { continue; }
    const roots = Array.isArray(data) ? data : [data];
    nodes.push(...roots.flatMap((root) =>
      Array.isArray(root?.["@graph"]) ? root["@graph"] : [root]));
  }
  return nodes;
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .trim();
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    out[match[1].toLowerCase()] = decodeHtml(match[3]);
  }
  return out;
}

function metaMap(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = attrs.property ?? attrs.name ?? attrs.itemprop;
    if (key && attrs.content) out.set(key.toLowerCase(), attrs.content);
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (title) out.set("html:title", decodeHtml(title.replace(/<[^>]+>/g, "")));
  return out;
}

function textCandidate(
  value: unknown, label: string, context: string, path: string,
): Candidate | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text) return null;
  return { value: null, valueText: text, unit: null, label, context, path };
}

function directValue(node: any, fieldName: string): unknown {
  const wanted = fieldName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return Object.entries(node ?? {}).find(([key]) =>
    key.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted)?.[1];
}

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

  for (const node of jsonLdNodes(html)) {
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
  return out;
}

/** Extract schema.org/Open Graph values for a caller-authored structured field list. */
export function extractGenericFields(
  html: string,
  requests: GenericFieldRequest[],
): Record<string, Candidate[]> {
  const nodes = jsonLdNodes(html);
  const meta = metaMap(html);
  const fields: Record<string, Candidate[]> = {};

  for (const request of requests) {
    const lower = request.name.toLowerCase();
    const candidates: Candidate[] = [];
    const isPrice = request.type === "money"
      || /(^|[_-])(price|cost|amount|fare)($|[_-])/.test(lower);

    for (const node of nodes) {
      const context = String(node?.["@type"] ?? "schema.org");
      if (isPrice) {
        const offers = node?.offers;
        for (const offer of Array.isArray(offers) ? offers : offers ? [offers] : []) {
          const parsed = parseRawValue(offer.price ?? offer.lowPrice);
          if (parsed.value !== null) candidates.push({
            value: parsed.value,
            valueText: null,
            unit: offer.priceCurrency ?? null,
            label: node.name ?? request.name,
            context,
            path: "jsonld>offers",
          });
        }
      } else {
        const raw = directValue(node, request.name)
          ?? (/name|title/.test(lower) ? (node.name ?? node.headline) : undefined)
          ?? (/description|summary/.test(lower) ? node.description : undefined);
        if (request.type === "number") {
          const parsed = parseRawValue(raw);
          if (parsed.value !== null) candidates.push({
            value: parsed.value, valueText: null, unit: null,
            label: request.name, context, path: `jsonld>${request.name}`,
          });
        } else {
          const candidate = textCandidate(raw, request.name, context, `jsonld>${request.name}`);
          if (candidate) candidates.push(candidate);
        }
      }
    }

    if (candidates.length === 0) {
      if (isPrice) {
        const raw = meta.get("product:price:amount") ?? meta.get("og:price:amount")
          ?? meta.get("price");
        const parsed = parseRawValue(raw);
        if (parsed.value !== null) candidates.push({
          value: parsed.value,
          valueText: null,
          unit: meta.get("product:price:currency") ?? meta.get("og:price:currency") ?? null,
          label: request.name,
          context: "metadata",
          path: "meta>price",
        });
      } else {
        const raw = /name|title/.test(lower)
          ? (meta.get("og:title") ?? meta.get("twitter:title") ?? meta.get("html:title"))
          : /description|summary/.test(lower)
            ? (meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description"))
            : meta.get(lower);
        if (request.type === "number") {
          const parsed = parseRawValue(raw);
          if (parsed.value !== null) candidates.push({
            value: parsed.value, valueText: null, unit: null,
            label: request.name, context: "metadata", path: `meta>${request.name}`,
          });
        } else {
          const candidate = textCandidate(raw, request.name, "metadata", `meta>${request.name}`);
          if (candidate) candidates.push(candidate);
        }
      }
    }
    if (candidates.length) fields[request.name] = candidates;
  }
  return fields;
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
  const type = /price|cost|amount|fare/i.test(field) ? "money" : "string";
  return runGenericFields(url, [{ name: field, type }], fetchImpl);
}

/** Fetch once and extract every requested structured field from the same source capture. */
export async function runGenericFields(
  url: string,
  fields: GenericFieldRequest[],
  fetchImpl: typeof fetch = fetch,
): Promise<CollectRunResult> {
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": ROBOTS_UA },
      signal: AbortSignal.timeout(GENERIC_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { status: "error", error: `HTTP ${res.status}` };

    const extracted = extractGenericFields(await res.text(), fields);
    const record: CollectorRecord = {
      url, fetchedAt: new Date().toISOString(), collectorVersion: GENERIC_COLLECTOR_ID,
      pageSignature: "", fields: extracted,
    };
    return Object.keys(extracted).length ? { status: "ok", record } : { status: "empty", record };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
