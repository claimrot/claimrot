import { safeUrl } from "../url.js";

export type RegistryEntry = { pattern: RegExp; collectorId: string };

/**
 * Sentinel collector ID for every URL this registry doesn't recognise — the
 * unmatched host tail, spec §7 (the 352-host tail this whole pitch rests on)
 * — and for any URL too malformed to resolve a host from at all. There is no
 * real Bright Data collector called "generic"; a caller must intercept this
 * ID (see collect/generic.ts's runGeneric) before it ever reaches
 * runCollector/healCollector, or every unmatched host silently resolves
 * UNVERIFIABLE forever.
 */
export const GENERIC_COLLECTOR_ID = "generic";

export function isGenericCollector(collectorId: string): boolean {
  return collectorId === GENERIC_COLLECTOR_ID;
}

/**
 * Collectors bind to HOST FAMILIES, not to claims. The unmatched tail falls to
 * the generic collector — and the generic collector is the one that heals most.
 * Collector IDs are filled in from `bdata scraper create` output during setup.
 */
export const DEFAULT_REGISTRY: RegistryEntry[] = [
  { pattern: /(^|\.)fareharbor\.com$/, collectorId: "c_fareharbor" },
  { pattern: /(^|\.)doc\.govt\.nz$/, collectorId: "c_doc_alerts" },
  { pattern: /(^|\.)realnz\.com$/, collectorId: "c_realnz" },
  { pattern: /(^|\.)whalewatch\.co\.nz$/, collectorId: "c_whalewatch" },
  { pattern: /(^|\.)bungy\.co\.nz$/, collectorId: "c_bungy" },
  // Busiest host in the corpus (86 URLs) and known to refuse plain fetches —
  // it needs real rendering, which makes it an honest robustness test.
  { pattern: /(^|\.)viator\.com$/, collectorId: "c_viator" },
];

export function resolveCollector(url: string, table: RegistryEntry[] = DEFAULT_REGISTRY): string {
  const parsed = safeUrl(url);
  if (!parsed) return GENERIC_COLLECTOR_ID;
  return table.find((e) => e.pattern.test(parsed.host))?.collectorId ?? GENERIC_COLLECTOR_ID;
}
