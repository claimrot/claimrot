import { describe, expect, it, vi } from "vitest";
import type { CollectRunResult } from "../../src/collect/types.js";
import { openDb } from "../../src/db/index.js";
import { executeExtraction, type ExtractionServiceDeps } from "../../src/extract/service.js";
import { getMonitorSnapshot, upsertExtractionMonitor } from "../../src/extract/store.js";
import type { ExtractionDefinition } from "../../src/extract/schema.js";

const definition: ExtractionDefinition = {
  fields: {
    name: { type: "string", description: "Product name" },
    description: { type: "text", description: "Product description" },
    price: { type: "money", description: "Current price" },
  },
};

const immediateQueue = {
  run<T>(_url: string, task: () => Promise<T>): Promise<T> { return task(); },
};

function record(price = 175): CollectRunResult {
  return {
    status: "ok",
    record: {
      url: "https://shop.example/product",
      fetchedAt: "2026-08-21T00:00:00Z",
      collectorVersion: "generic",
      pageSignature: "sig",
      fields: {
        name: [{ value: null, valueText: "Ocean Cabin", unit: null, label: "name", context: "Product", path: "jsonld>name" }],
        description: [{ value: null, valueText: "A quiet cabin tour", unit: null, label: "description", context: "Product", path: "jsonld>description" }],
        price: [{ value: price, valueText: null, unit: "NZD", label: "Ocean Cabin", context: "Product", path: "jsonld>offers" }],
      },
    },
  };
}

function setup(collectorId = "generic") {
  const db = openDb(":memory:");
  upsertExtractionMonitor(db, {
    id: "product",
    sourceUrl: "https://shop.example/product",
    definition,
    intervalDays: 7,
    collectorId,
    now: "2026-08-21T00:00:00Z",
  });
  return db;
}

function deps(run: ExtractionServiceDeps["run"]): ExtractionServiceDeps {
  return {
    queue: immediateQueue,
    fetchRobots: async () => "",
    run,
    now: () => new Date("2026-08-21T01:00:00Z"),
  };
}

describe("structured extraction service", () => {
  it("persists a complete run, exposes current values, and skips until due", async () => {
    const db = setup();
    const run = vi.fn(async () => record());
    const first = await executeExtraction(db, "product", { force: true }, deps(run));
    expect(first.status).toBe("SUCCEEDED");
    expect(first.fields.price.value).toBe(175);
    expect(first.fields.price.unit).toBe("NZD");
    expect(first.nextRunAt).toBe("2026-08-28T01:00:00.000Z");

    const snapshot = getMonitorSnapshot(db, "product")!;
    expect(snapshot.fields.name.value).toBe("Ocean Cabin");
    expect(snapshot.latestRun?.status).toBe("SUCCEEDED");
    expect(db.prepare("SELECT COUNT(*) AS n FROM extracted_values").get()).toEqual({ n: 3 });

    const skipped = await executeExtraction(db, "product", {}, deps(run));
    expect(skipped.status).toBe("SKIPPED");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("records a dry-run without replacing the current persisted result", async () => {
    const db = setup();
    await executeExtraction(db, "product", { force: true }, deps(async () => record(175)));
    const tested = await executeExtraction(
      db, "product", { force: true, dryRun: true }, deps(async () => record(199)),
    );
    expect(tested.dryRun).toBe(true);
    expect(tested.fields.price.value).toBe(199);
    expect(getMonitorSnapshot(db, "product")!.fields.price.value).toBe(175);
    expect(db.prepare("SELECT COUNT(*) AS n FROM extraction_runs WHERE dry_run=1").get())
      .toEqual({ n: 1 });
  });

  it("heals a registered collector once, retries, and records the outcome", async () => {
    const db = setup("c_product");
    const incomplete: CollectRunResult = {
      status: "ok",
      record: {
        url: "https://shop.example/product", fetchedAt: "2026-08-21", collectorVersion: "v1",
        pageSignature: "", fields: { name: (record() as any).record.fields.name },
      },
    };
    const run = vi.fn()
      .mockResolvedValueOnce(incomplete)
      .mockResolvedValueOnce(record());
    const heal = vi.fn(async () => ({
      status: "healed" as const, collectorVersion: "v2", preview: {},
    }));
    const result = await executeExtraction(db, "product", { force: true }, {
      ...deps(run), heal,
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.healStatus).toBe("SUCCEEDED");
    expect(run).toHaveBeenCalledTimes(2);
    expect(heal).toHaveBeenCalledTimes(1);
    expect(getMonitorSnapshot(db, "product")!.latestRun?.healStatus).toBe("SUCCEEDED");
  });

  it("declares generic healing unavailable and respects robots.txt", async () => {
    const db = setup();
    const onlyName: CollectRunResult = {
      status: "ok",
      record: {
        url: "https://shop.example/product", fetchedAt: "2026-08-21", collectorVersion: "generic",
        pageSignature: "", fields: { name: (record() as any).record.fields.name },
      },
    };
    const partial = await executeExtraction(db, "product", { force: true }, deps(async () => onlyName));
    expect(partial.status).toBe("PARTIAL");
    expect(partial.healStatus).toBe("UNAVAILABLE");
    expect(partial.fields.price.error).toMatch(/no bright data collector is registered/i);

    const blockedDb = setup();
    const run = vi.fn(async () => record());
    const blocked = await executeExtraction(blockedDb, "product", { force: true }, {
      ...deps(run), fetchRobots: async () => "User-agent: *\nDisallow: /product",
    });
    expect(blocked.status).toBe("BLOCKED");
    expect(run).not.toHaveBeenCalled();
  });
});
