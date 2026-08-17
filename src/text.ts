/**
 * Case-insensitive, punctuation-blind text normalisation shared by every
 * anchor/label comparison in the codebase (resolve/score.ts, collect/studio.ts,
 * engine/check.ts): lowercase, collapse every run of non-alphanumeric
 * characters to a single space, trim.
 */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** `normalize(s)`, split on whitespace, empty tokens dropped, as a Set. */
export function tokenSet(s: string): Set<string> {
  return new Set(normalize(s).split(" ").filter(Boolean));
}

/** True when every token of `a` also appears in `b`. */
export function isTokenSubset(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (!b.has(t)) return false;
  return true;
}
