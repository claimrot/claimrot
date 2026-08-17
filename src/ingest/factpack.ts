import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Claim } from "../model/types.js";

/** Authenticated partner API — the hackathon rules require public data only. */
const EXCLUDED_HOSTS = new Set(["api.viator.com"]);

export function readFactPack(path: string): Claim[] {
  const pack = JSON.parse(readFileSync(path, "utf8"));
  const documentId = pack.slug ?? basename(path).replace(/\.facts\.json$/, "");

  return (pack.facts ?? []).flatMap((f: any): Claim[] => {
    const url = (f.source_url ?? "").trim();
    if (!url) return [];
    let host: string;
    try { host = new URL(url).host; } catch { return []; }
    if (EXCLUDED_HOSTS.has(host)) return [];

    return [{
      id: `${documentId}#${f.id}`,
      documentId,
      text: f.claim ?? "",
      sourceUrl: url,
      ingestedAt: new Date().toISOString(),
      checkedAt: f.checked_at ?? pack.as_of ?? "",
      volatile: Boolean(f.volatile),
      expiresAt: null,
      status: "active",
    }];
  });
}
