import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  monitorIdFor, parseIntervalDays, readExtractionSchema,
} from "../../src/extract/schema.js";

describe("extraction schema", () => {
  it("reads a strict field definition and derives a stable URL-specific ID", () => {
    const directory = mkdtempSync(join(tmpdir(), "claimrot-schema-"));
    try {
      const path = join(directory, "product.json");
      writeFileSync(path, JSON.stringify({
        fields: {
          name: { type: "string", description: "Product name" },
          price: { type: "money", description: "Current price" },
        },
        intervalDays: 7,
      }));
      expect(readExtractionSchema(path).fields.price.type).toBe("money");
      expect(monitorIdFor("https://shop.example/products/red-shoe"))
        .toMatch(/^shop-example-products-red-shoe-[a-f0-9]{8}$/);
      expect(monitorIdFor("https://shop.example/products/red-shoe"))
        .toBe(monitorIdFor("https://shop.example/products/red-shoe"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid fields and unsafe intervals", () => {
    const directory = mkdtempSync(join(tmpdir(), "claimrot-schema-"));
    try {
      const path = join(directory, "bad.json");
      writeFileSync(path, JSON.stringify({ fields: {} }));
      expect(() => readExtractionSchema(path)).toThrow(/at least one field/i);
      expect(() => parseIntervalDays("0")).toThrow(/1 to 365/);
      expect(() => parseIntervalDays("1.5")).toThrow(/whole number/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
