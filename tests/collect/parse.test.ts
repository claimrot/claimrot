import { describe, it, expect } from "vitest";
import { parseRawValue } from "../../src/collect/parse.js";

// Table-driven over every input in the final fix wave's Fix 1 (2026-08-17):
// a wrong-but-confident number is the worst outcome claimrot can produce (it
// becomes a DRIFTED verdict at confidence 1.00), so an unparseable value must
// return null (heal) rather than a guess.
const CASES: [string, number | null][] = [
  // Must parse to the given number.
  ["0", 0],
  ["0.00", 0],
  ["175", 175],
  ["NZ$175.00", 175],
  ["$1,175", 1175],
  ["1,234.56", 1234.56],
  ["-175", -175],
  [" 175 ", 175],
  ["175 NZD", 175],
  // Must return null.
  ["$175 (was $195)", null], // strike-through price: two disjoint digit groups
  ["175-185", null], // a range, not a single value
  ["175–185", null], // en dash range
  ["175 per adult", null], // trailing lowercase prose must not be swallowed
  ["free", null],
  ["N/A", null],
  ["12/08/2026", null],
  ["1 adult 175", null],
  ["NaN", null],
  ["Infinity", null],
  ["175,00", null], // European decimal comma — ambiguous, refuse rather than guess
  ["1.234,56", null], // same ambiguity, with a thousands-dot too
  ["10:30am", null],
  ["2 tours daily", null],
];

describe("parseRawValue", () => {
  it.each(CASES)("parses %j to %j", (raw, expected) => {
    expect(parseRawValue(raw).value).toBe(expected);
  });

  it("keeps the trimmed original string in valueText for STRING input, whether or not a number was extracted", () => {
    // The scar: "10:30am" used to become { value: 1030, valueText: null },
    // which broke `contains "10:30am"` because the text was discarded the
    // moment a (wrong) number was found.
    expect(parseRawValue("10:30am")).toEqual({ value: null, valueText: "10:30am" });
    expect(parseRawValue(" 175 ")).toEqual({ value: 175, valueText: "175" });
    expect(parseRawValue("$175 (was $195)")).toEqual({ value: null, valueText: "$175 (was $195)" });
  });

  it("blank or whitespace-only input yields null/null, never a numeric zero", () => {
    expect(parseRawValue("")).toEqual({ value: null, valueText: null });
    expect(parseRawValue("   ")).toEqual({ value: null, valueText: null });
  });

  it("numeric and non-string input keep their prior behaviour", () => {
    expect(parseRawValue(175)).toEqual({ value: 175, valueText: null });
    expect(parseRawValue(NaN)).toEqual({ value: null, valueText: null });
    expect(parseRawValue(null)).toEqual({ value: null, valueText: null });
    expect(parseRawValue(undefined)).toEqual({ value: null, valueText: null });
  });
});
