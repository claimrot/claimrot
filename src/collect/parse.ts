/**
 * Parses a raw extracted value into a numeric value and/or a text fallback.
 *
 * Two failure modes this exists to prevent, both found in the wild from a
 * real Scraper Studio collector (probe A, 2026-08-17):
 *
 * 1. `Number("")` is `0` and `Number("  ")` is `0`. A blank or whitespace-only
 *    string is how an AI-authored collector says "I couldn't find it" — naive
 *    coercion turned that into a confident numeric zero, which resolve.ts then
 *    compared against the expected value and reported as `DRIFTED`. Blank
 *    input is guarded BEFORE calling `Number()` and always yields `null`,
 *    never `0`.
 * 2. `Number("NZ$175.00")` is `NaN`. A currency-formatted, thousands-separated
 *    string is the SAME price, just formatted — a heal can legitimately change
 *    output format without changing the underlying fact. Currency symbols,
 *    thousands separators and surrounding whitespace are stripped before
 *    coercion so the number the string plainly names is the number we get.
 *
 * If, after stripping, the result still doesn't parse to a finite number, the
 * original (trimmed) string is kept in `valueText` and `value` stays `null` —
 * unreadable, never guessed at.
 */
export function parseRawValue(raw: unknown): { value: number | null; valueText: string | null } {
  if (typeof raw === "number") {
    return { value: Number.isFinite(raw) ? raw : null, valueText: null };
  }
  if (typeof raw !== "string") return { value: null, valueText: null };

  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, valueText: null };

  // Strip everything but digits, a decimal point, exponent marker and sign —
  // i.e. drop currency symbols/codes and thousands separators.
  const cleaned = trimmed.replace(/[^\d.eE+-]/g, "");
  const num = cleaned === "" ? NaN : Number(cleaned);
  return Number.isFinite(num) ? { value: num, valueText: null } : { value: null, valueText: trimmed };
}
