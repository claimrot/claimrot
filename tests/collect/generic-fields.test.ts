import { describe, expect, it, vi } from "vitest";
import { extractGenericFields, runGenericFields } from "../../src/collect/generic.js";

const requests = [
  { name: "name", type: "string" as const },
  { name: "description", type: "text" as const },
  { name: "price", type: "money" as const },
];

describe("generic structured fields", () => {
  it("extracts product name, description, and price from one JSON-LD product", () => {
    const html = `<script type="application/ld+json">{
      "@type":"Product","name":"Trail Shoe","description":"Built for wet tracks",
      "offers":{"price":"129.95","priceCurrency":"NZD"}
    }</script>`;
    const fields = extractGenericFields(html, requests);
    expect(fields.name[0].valueText).toBe("Trail Shoe");
    expect(fields.description[0].valueText).toBe("Built for wet tracks");
    expect(fields.price[0]).toMatchObject({ value: 129.95, unit: "NZD" });
  });

  it("falls back to Open Graph and product price metadata and fetches only once", async () => {
    const html = `<title>Fallback title</title>
      <meta property="og:title" content="Red Shoe">
      <meta name="description" content="A light everyday shoe">
      <meta property="product:price:amount" content="89">
      <meta property="product:price:currency" content="NZD">`;
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200 }));
    const result = await runGenericFields(
      "https://shop.example/red-shoe", requests, fetchImpl as unknown as typeof fetch,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.record.fields.name[0].valueText).toBe("Red Shoe");
      expect(result.record.fields.price[0].value).toBe(89);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
