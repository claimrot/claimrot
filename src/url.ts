/**
 * Parses a URL, returning null instead of throwing on anything malformed.
 * Every call site (collect/registry.ts, ingest/factpack.ts, net/politeness.ts,
 * src/cli.ts) has its own idea of what a bad URL should do next — fall back to
 * a sentinel collector, skip the row, reject the promise — so this stays a
 * plain parse-or-null and does not itself pick a fallback.
 */
export function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}
