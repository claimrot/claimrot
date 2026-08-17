/**
 * Parses a raw extracted value into a numeric value and/or a text fallback.
 *
 * Three failure modes this exists to prevent, all found in the wild from a
 * real Scraper Studio collector (probe A, 2026-08-17) or from a fix wave that
 * introduced new instances of the same family (2026-08-17):
 *
 * 1. `Number("")` is `0` and `Number("  ")` is `0`. A blank or whitespace-only
 *    string is how an AI-authored collector says "I couldn't find it" — naive
 *    coercion turned that into a confident numeric zero, which resolve.ts then
 *    compared against the expected value and reported as `DRIFTED`. Blank
 *    input is guarded BEFORE calling `Number()` and always yields `null`,
 *    never `0`.
 * 2. A strip-everything-but-digits approach (the prior version of this
 *    function) concatenates DISJOINT digit groups: `"$175 (was $195)"`, a
 *    routine strike-through price on a commerce page, became `"175195"` ->
 *    175195. A wrong-but-confident number is the worst outcome this whole
 *    project exists to prevent — it becomes a `DRIFTED` verdict at confidence
 *    1.00. `NUMERIC` below matches exactly ONE numeric token and refuses
 *    everything else, because a `null` (heal) is always safer than a guess.
 * 3. A comma is only ever treated as a thousands separator here. `"175,00"`
 *    and `"1.234,56"` use it as a decimal point (European convention), and
 *    telling that apart from a thousands separator needs locale knowledge we
 *    do not have. Guessing which convention applies is exactly the failure
 *    being fixed, so both return `null` rather than a guessed value.
 *
 * If nothing matches, the original (trimmed) string is kept in `valueText`
 * (see the caller-facing contract below) and `value` stays `null` —
 * unreadable, never guessed at.
 */
// Exactly one numeric token, surrounded only by whitespace, a currency
// symbol, or a SHORT UPPERCASE currency code ("NZ$175.00", "175 NZD"). Never
// lowercase prose: "175 per adult" must not yield 175, because `\D*` (used by
// an earlier draft of this pattern) matches letters too and would swallow
// trailing prose right along with punctuation.
const NUMERIC =
  /^\s*[A-Z]{0,3}\s*[$€£¥]?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*[A-Z]{0,3}\s*$/;

export function parseRawValue(raw: unknown): { value: number | null; valueText: string | null } {
  if (typeof raw === "number") {
    return { value: Number.isFinite(raw) ? raw : null, valueText: null };
  }
  if (typeof raw !== "string") return { value: null, valueText: null };

  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, valueText: null };

  // For STRING input, the trimmed original is always kept in valueText —
  // whether or not a number was extracted. `"10:30am"` has no clean numeric
  // token (correctly), but `contains`/`exists` assertions still need the raw
  // text to compare against; dropping it here silently broke `contains
  // "10:30am"` once the number was found, which is not this function's call
  // to make.
  const m = trimmed.match(NUMERIC);
  const num = m ? Number(m[1].replace(/,/g, "")) : NaN;
  return { value: Number.isFinite(num) ? num : null, valueText: trimmed };
}
