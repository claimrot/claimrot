import { describe, it, expect } from "vitest";
import { resolveCollector, DEFAULT_REGISTRY } from "../../src/collect/registry.js";

describe("resolveCollector", () => {
  it("matches a host family", () => {
    const table = [{ pattern: /(^|\.)fareharbor\.com$/, collectorId: "c_fareharbor" }];
    expect(resolveCollector("https://fareharbor.com/embeds/book/x", table)).toBe("c_fareharbor");
  });

  it("falls back to generic for an unknown host — the 352-host tail", () => {
    expect(resolveCollector("https://some-operator.example/tours", [])).toBe("generic");
  });

  it("ships a non-empty default registry", () => {
    expect(DEFAULT_REGISTRY.length).toBeGreaterThan(0);
  });

  it("falls back to generic on a malformed URL instead of throwing", () => {
    // Called per-claim across 942 corpus URLs; a malformed entry is an ordinary
    // data defect, not an exotic one.
    expect(resolveCollector("not a url")).toBe("generic");
  });
});
