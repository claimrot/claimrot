import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../../src/db/index.js";
import { upsertExtractionMonitor } from "../../src/extract/store.js";
import type { ExtractionOutcome } from "../../src/extract/types.js";
import { startViewServer } from "../../src/server/view.js";

describe("claimrot view server", () => {
  it("serves locally and requires its per-process token for operational actions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claimrot-view-"));
    const database = join(directory, "claimrot.db");
    const db = openDb(database);
    upsertExtractionMonitor(db, {
      id: "shoe", sourceUrl: "https://shop.example/shoe",
      definition: { fields: { price: { type: "money", description: "Price" } } },
      intervalDays: 7, collectorId: "generic", now: "2026-08-21T00:00:00Z",
    });
    db.close();
    const outcome: ExtractionOutcome = {
      monitorId: "shoe", url: "https://shop.example/shoe", runId: "test",
      status: "SUCCEEDED", dryRun: true, scrapedAt: "2026-08-21", nextRunAt: null,
      collectorId: "generic", collectorVersion: "generic", healStatus: "NOT_NEEDED",
      error: null, fields: {},
    };
    const execute = vi.fn(async () => outcome);
    const server = await startViewServer(database, { port: 0, execute });
    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Extraction monitors");
      const token = /const token="([a-f0-9]+)"/.exec(html)?.[1];
      expect(token).toBeTruthy();

      expect((await fetch(`${server.url}api/test/shoe`, { method: "POST" })).status).toBe(403);
      const action = await fetch(`${server.url}api/test/shoe`, {
        method: "POST", headers: { "x-claimrot-token": token! },
      });
      expect(action.status).toBe(200);
      expect(execute).toHaveBeenCalledWith(expect.anything(), "shoe", {
        force: true, dryRun: true,
      });
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
