import type { Assertion } from "../model/types.js";
import { ROBOTS_UA } from "../net/politeness.js";
import { normalize, tokenSet } from "../text.js";
import { safeUrl } from "../url.js";

/** Never try more than this many successor pages for one vanished anchor. */
export const MAX_SUCCESSORS = 5;
/** A candidate must share at least this fraction of the anchor's tokens to be worth a fetch. */
const MIN_OVERLAP = 0.5;
const FETCH_TIMEOUT_MS = 10_000;
/** Sitemaps can be enormous; read a bounded prefix rather than the whole file. */
const SITEMAP_MAX_BYTES = 2_000_000;

export interface SuccessorCandidate {
  url: string;
  /** Why this URL was proposed — carried into the verdict's reason so a MOVED is auditable. */
  why: string;
  score: number;
}

/**
 * Extracts `<a href>` targets and their link text, resolved against `baseUrl`.
 *
 * Deliberately a regex rather than a DOM parse: this runs on pages we have
 * already decided are uncooperative, the output is only ever used to propose a
 * URL that is then verified by a real collector run, and a malformed match
 * costs one wasted fetch rather than a wrong verdict.
 */
export function extractLinks(html: string, baseUrl: string): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const href = m[1].trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    let resolved: URL | null = null;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    resolved.hash = "";
    out.push({ url: resolved.toString(), text: m[2].replace(/<[^>]*>/g, " ").trim() });
  }
  return out;
}

/** `<loc>` entries of a sitemap. Same reasoning as extractLinks on the regex. */
export function extractSitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}

/**
 * Fraction of the anchor's tokens that appear in `haystack`. Asymmetric on
 * purpose, exactly as anchor scoring is: a long page title that happens to
 * contain "Adult" and "Ocean Cabin" is a fine successor, and must not be
 * punished for carrying words the anchor never had.
 */
export function anchorOverlap(a: Assertion, haystack: string): number {
  const want = tokenSet(`${a.anchorLabel} ${a.anchorContext}`);
  if (want.size === 0) return 0;
  const have = tokenSet(haystack);
  let hit = 0;
  for (const t of want) if (have.has(t)) hit++;
  return hit / want.size;
}

/** Path plus link text is what we match against — a slug carries as much intent as prose. */
const haystackFor = (url: string, text: string) => {
  const u = safeUrl(url);
  return `${text} ${u ? decodeURIComponent(u.pathname) : ""}`;
};

async function getText(url: string, fetchImpl: typeof fetch, cap?: number): Promise<string | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": ROBOTS_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.text();
    return cap ? body.slice(0, cap) : body;
  } catch {
    return null;
  }
}

export interface DiscoverDeps {
  fetchImpl?: typeof fetch;
  /** Robots gate for the host, supplied by the caller that already loaded robots.txt. */
  isAllowedPath?: (path: string) => boolean;
  /** Called with candidates dropped by the cap, so a bounded search never looks exhaustive. */
  onDropped?: (dropped: number) => void;
  /**
   * Awaited before every request after the first. HostQueue spaces queue SLOTS,
   * not the requests inside one, so without this the whole relocation path
   * would burst at a single host behind one slot's pacing.
   */
  pace?: () => Promise<void>;
}

/**
 * Proposes successor pages for an assertion whose anchor vanished from `url`,
 * ranked best-first, using only signals the SITE ITSELF publishes: links on
 * the cited page, then the host's sitemap. No search engine, and never
 * another host.
 *
 * Same-host is a safety property, not a convenience. The caller is already
 * inside this host's queue slot holding this host's robots.txt, so every
 * request this provokes inherits the pacing and the permission we already
 * established. A cross-host successor would escape both, and 375 concurrent
 * probes against a partner once cost them a ninety-minute outage.
 */
export async function discoverSuccessors(
  url: string, assertion: Assertion, deps: DiscoverDeps = {},
): Promise<SuccessorCandidate[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const origin = safeUrl(url);
  if (!origin) return [];

  const sameHost = (u: string) => {
    const p = safeUrl(u);
    return p !== null && p.host === origin.host;
  };
  const permitted = (u: string) => {
    const p = safeUrl(u);
    if (!p) return false;
    return deps.isAllowedPath ? deps.isAllowedPath(p.pathname || "/") : true;
  };

  const seen = new Set<string>([url]);
  const scored: SuccessorCandidate[] = [];
  const consider = (candidate: string, text: string, why: string) => {
    if (seen.has(candidate) || !sameHost(candidate) || !permitted(candidate)) return;
    seen.add(candidate);
    const score = anchorOverlap(assertion, haystackFor(candidate, text));
    if (score >= MIN_OVERLAP) scored.push({ url: candidate, why, score });
  };

  const page = await getText(url, fetchImpl);
  if (page) {
    for (const link of extractLinks(page, url)) {
      consider(link.url, link.text, `linked from the cited page as "${normalize(link.text).slice(0, 60)}"`);
    }
  }

  // Only pay for the sitemap when the page's own links produced nothing.
  if (scored.length === 0) {
    await deps.pace?.();
    const sitemap = await getText(new URL("/sitemap.xml", origin).toString(), fetchImpl, SITEMAP_MAX_BYTES);
    if (sitemap) {
      for (const loc of extractSitemapUrls(sitemap)) consider(loc, "", "listed in the host's sitemap.xml");
    }
  }

  scored.sort((a, b) => b.score - a.score);
  if (scored.length > MAX_SUCCESSORS) deps.onDropped?.(scored.length - MAX_SUCCESSORS);
  return scored.slice(0, MAX_SUCCESSORS);
}
