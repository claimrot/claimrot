import { describe, it, expect } from "vitest";
import {
  discoverSuccessors, extractLinks, extractSitemapUrls, anchorOverlap, MAX_SUCCESSORS,
} from "../../src/collect/successor.js";
import type { Assertion } from "../../src/model/types.js";

const a: Assertion = {
  id: "a1", claimId: "c1", field: "adult_price", op: "eq",
  valueNum: 175, valueText: null, valueMax: null, unit: "NZD", tolerance: null,
  anchorLabel: "Adult", anchorContext: "Ocean Cabin", anchorPath: "",
};

/** Serves a fixed body per URL; any URL not in the map 404s. */
const fakeFetch = (pages: Record<string, string>) =>
  (async (url: any) => {
    const body = pages[String(url)];
    return body === undefined
      ? { ok: false, status: 404, text: async () => "" }
      : { ok: true, status: 200, text: async () => body };
  }) as unknown as typeof fetch;

describe("extractLinks", () => {
  it("resolves relative hrefs against the base and strips markup from link text", () => {
    const html = `<a href="/tours/ocean-cabin"><span>Ocean</span> Cabin</a>`;
    expect(extractLinks(html, "https://x.example/old")).toEqual([
      { url: "https://x.example/tours/ocean-cabin", text: "Ocean  Cabin" },
    ]);
  });

  it("drops fragments, mailto and javascript targets", () => {
    const html = `<a href="#top">t</a><a href="mailto:a@b.c">m</a><a href="javascript:void(0)">j</a>`;
    expect(extractLinks(html, "https://x.example/")).toEqual([]);
  });
});

describe("anchorOverlap", () => {
  it("is asymmetric — extra words in the haystack are not punished", () => {
    const exact = anchorOverlap(a, "Adult Ocean Cabin");
    const verbose = anchorOverlap(a, "Book the Ocean Cabin tour — Adult and child fares, 2026 season");
    expect(exact).toBe(1);
    expect(verbose).toBe(1);
  });

  it("scores partial matches by the fraction of anchor tokens present", () => {
    expect(anchorOverlap(a, "Ocean Cabin")).toBeCloseTo(2 / 3);
    expect(anchorOverlap(a, "Gift vouchers")).toBe(0);
  });
});

describe("extractSitemapUrls", () => {
  it("reads loc entries", () => {
    expect(extractSitemapUrls("<url><loc>https://x.example/a</loc></url>"))
      .toEqual(["https://x.example/a"]);
  });
});

describe("discoverSuccessors", () => {
  const cited = "https://x.example/old-tour";

  it("proposes a same-host page linked from the cited page", async () => {
    const found = await discoverSuccessors(cited, a, {
      fetchImpl: fakeFetch({
        [cited]: `<a href="/ocean-cabin-adult">Ocean Cabin — Adult fares</a>
                  <a href="/about">About us</a>`,
      }),
    });
    expect(found.map((f) => f.url)).toEqual(["https://x.example/ocean-cabin-adult"]);
    expect(found[0].why).toContain("linked from the cited page");
  });

  it("never leaves the host, however good the match", async () => {
    const found = await discoverSuccessors(cited, a, {
      fetchImpl: fakeFetch({
        [cited]: `<a href="https://other.example/ocean-cabin-adult">Ocean Cabin Adult</a>`,
      }),
    });
    expect(found).toEqual([]);
  });

  it("honours robots.txt for the successor, not just the cited page", async () => {
    const pages = { [cited]: `<a href="/private/ocean-cabin-adult">Ocean Cabin Adult</a>` };
    const permitted = await discoverSuccessors(cited, a, { fetchImpl: fakeFetch(pages) });
    const blocked = await discoverSuccessors(cited, a, {
      fetchImpl: fakeFetch(pages),
      isAllowedPath: (p) => !p.startsWith("/private"),
    });
    expect(permitted).toHaveLength(1);
    expect(blocked).toEqual([]);
  });

  it("falls back to the sitemap only when the page's own links yield nothing", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (url: any) => {
      requested.push(String(url));
      const pages: Record<string, string> = {
        [cited]: `<a href="/about">About us</a>`,
        "https://x.example/sitemap.xml": `<loc>https://x.example/ocean-cabin/adult</loc>`,
      };
      const body = pages[String(url)];
      return body === undefined
        ? { ok: false, status: 404, text: async () => "" }
        : { ok: true, status: 200, text: async () => body };
    }) as unknown as typeof fetch;

    const found = await discoverSuccessors(cited, a, { fetchImpl });
    expect(requested).toContain("https://x.example/sitemap.xml");
    expect(found[0].url).toBe("https://x.example/ocean-cabin/adult");
    expect(found[0].why).toContain("sitemap");
  });

  it("does not fetch the sitemap when on-page links already matched", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (url: any) => {
      requested.push(String(url));
      return { ok: true, status: 200, text: async () => `<a href="/ocean-cabin-adult">Ocean Cabin Adult</a>` };
    }) as unknown as typeof fetch;
    await discoverSuccessors(cited, a, { fetchImpl });
    expect(requested).not.toContain("https://x.example/sitemap.xml");
  });

  it("caps the candidate list and reports what it dropped", async () => {
    const links = Array.from({ length: MAX_SUCCESSORS + 3 },
      (_, i) => `<a href="/p${i}/ocean-cabin-adult">Ocean Cabin Adult ${i}</a>`).join("");
    let dropped = 0;
    const found = await discoverSuccessors(cited, a, {
      fetchImpl: fakeFetch({ [cited]: links }),
      onDropped: (n) => { dropped = n; },
    });
    expect(found).toHaveLength(MAX_SUCCESSORS);
    expect(dropped).toBe(3);
  });

  it("never proposes the cited URL back to itself", async () => {
    const found = await discoverSuccessors(cited, a, {
      fetchImpl: fakeFetch({ [cited]: `<a href="/old-tour">Ocean Cabin Adult</a>` }),
    });
    expect(found).toEqual([]);
  });

  it("returns nothing rather than throwing when the cited page is unreachable", async () => {
    expect(await discoverSuccessors(cited, a, { fetchImpl: fakeFetch({}) })).toEqual([]);
  });
});
