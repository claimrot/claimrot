import { describe, it, expect } from "vitest";
import { extractJson, selectBackend, BACKENDS } from "../../src/ingest/backends.js";
import { NormalizedSchema, ASSERTIONS_JSON_SCHEMA } from "../../src/ingest/normalize.js";

const assertion = {
  field: "adult_price", op: "eq", valueNum: 175, valueText: null, valueMax: null,
  unit: "NZD", tolerance: null, anchorLabel: "Adult", anchorContext: "Ocean Cabin",
};

/**
 * Minimal check of the JSON Schema against a value: enough to catch the drift
 * this guards (a field added to one declaration and not the other, or an op
 * added to one enum), without pulling in a JSON Schema validator dependency.
 */
function jsonSchemaAccepts(value: unknown): boolean {
  const root = ASSERTIONS_JSON_SCHEMA;
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.assertions)) return false;
  if (Object.keys(v).some((k) => !(k in root.properties))) return false;

  const item = root.properties.assertions.items;
  return v.assertions.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    const props = item.properties as Record<string, { type: unknown; enum?: readonly string[] }>;
    if (Object.keys(e).some((k) => !(k in props))) return false;
    if (item.required.some((k) => !(k in e))) return false;
    return Object.entries(props).every(([key, spec]) => {
      const actual = e[key] === null ? "null" : typeof e[key];
      const allowed = Array.isArray(spec.type) ? spec.type : [spec.type];
      if (!allowed.includes(actual)) return false;
      return !spec.enum || spec.enum.includes(e[key] as string);
    });
  });
}

describe("the two schema declarations agree", () => {
  // ASSERTIONS_JSON_SCHEMA is what the model is constrained by; NormalizedSchema
  // is what we validate the answer with. If they drift, the model is told to
  // produce something we then reject — so every fixture must land the same way
  // in both.
  const fixtures: [string, unknown][] = [
    ["a well-formed assertion", { assertions: [assertion] }],
    ["an empty assertion list", { assertions: [] }],
    ["every nullable field null", { assertions: [{ ...assertion, valueNum: null, unit: null }] }],
    ["op: exists", { assertions: [{ ...assertion, op: "exists" }] }],
    ["op: range with a max", { assertions: [{ ...assertion, op: "range", valueMax: 200 }] }],
    ["an unknown op", { assertions: [{ ...assertion, op: "regex" }] }],
    ["a missing required field", { assertions: [{ ...assertion, anchorLabel: undefined }] }],
    ["an unexpected extra field", { assertions: [{ ...assertion, surprise: 1 }] }],
    ["a string where a number belongs", { assertions: [{ ...assertion, valueNum: "175" }] }],
    ["no assertions key at all", {}],
    ["a bare array", []],
  ];

  for (const [name, value] of fixtures) {
    it(name, () => {
      expect(jsonSchemaAccepts(value)).toBe(NormalizedSchema.safeParse(value).success);
    });
  }
});

describe("extractJson", () => {
  it("reads clean JSON", () => {
    expect(extractJson('{"assertions":[]}')).toEqual({ assertions: [] });
  });

  it("recovers JSON an agent wrapped in chatter", () => {
    expect(extractJson('Here you go:\n{"assertions":[]}\nHope that helps!'))
      .toEqual({ assertions: [] });
  });

  it("returns null rather than throwing on unparseable output", () => {
    expect(extractJson("I could not do that.")).toBeNull();
    expect(extractJson("{ not json at all")).toBeNull();
    expect(extractJson("")).toBeNull();
  });
});

describe("selectBackend", () => {
  const none = () => false;
  const all = () => true;

  it("honours an explicit --backend over anything the machine has", () => {
    expect(selectBackend("codex-cli", { ANTHROPIC_API_KEY: "sk-x" }, all).name).toBe("codex-cli");
  });

  it("honours CLAIMROT_INGEST when no flag is given", () => {
    expect(selectBackend(undefined, { CLAIMROT_INGEST: "claude-cli" }, none).name).toBe("claude-cli");
  });

  it("rejects an unknown backend by name, listing the real ones", () => {
    expect(() => selectBackend("gpt", {}, all)).toThrow(/unknown ingest backend "gpt"/);
    expect(() => selectBackend("gpt", {}, all)).toThrow(/api, claude-cli, codex-cli/);
  });

  it("prefers the API when a key is present", () => {
    expect(selectBackend(undefined, { ANTHROPIC_API_KEY: "sk-x" }, all).name).toBe("api");
  });

  it("falls back to claude-cli with no key, then codex-cli", () => {
    expect(selectBackend(undefined, {}, (b) => b === "claude").name).toBe("claude-cli");
    expect(selectBackend(undefined, {}, (b) => b === "codex").name).toBe("codex-cli");
  });

  it("explains itself when nothing is available, and says check/report are unaffected", () => {
    expect(() => selectBackend(undefined, {}, none)).toThrow(/no ingest backend available/);
    expect(() => selectBackend(undefined, {}, none)).toThrow(/check` and `report` do not/);
  });

  it("exposes exactly the three documented backends", () => {
    expect(Object.keys(BACKENDS)).toEqual(["api", "claude-cli", "codex-cli"]);
  });
});
