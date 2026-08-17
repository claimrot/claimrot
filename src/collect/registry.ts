export type RegistryEntry = { pattern: RegExp; collectorId: string };

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
  let host: string;
  try { host = new URL(url).host; } catch { return "generic"; }
  return table.find((e) => e.pattern.test(host))?.collectorId ?? "generic";
}
