import { describe, expect, it } from "vitest";
import { renderExtractionDashboard } from "../../src/report/extraction-dashboard.js";
import type { MonitorSnapshot } from "../../src/extract/types.js";

describe("operational extraction dashboard", () => {
  it("renders shared branding, values, controls, and escaped stored content", () => {
    const snapshot: MonitorSnapshot = {
      monitor: {
        id: "shoe", sourceUrl: "https://shop.example/shoe", intervalDays: 7,
        collectorId: "generic", createdAt: "2026-08-21", updatedAt: "2026-08-21",
        lastRunAt: "2026-08-21", nextRunAt: "2026-08-28", lastStatus: "SUCCEEDED",
        definition: { fields: { name: { type: "string", description: "<Product name>" } } },
      },
      latestRun: {
        id: "r", monitorId: "shoe", startedAt: "2026-08-21", completedAt: "2026-08-21",
        status: "SUCCEEDED", dryRun: false, collectorId: "generic",
        collectorVersion: "generic", healStatus: "NOT_NEEDED", error: null,
      },
      fields: {
        name: {
          field: "name", type: "string", status: "OK", value: "<Red Shoe>",
          valueNum: null, valueText: "<Red Shoe>", unit: null, label: "name",
          context: "Product", path: "jsonld>name", confidence: 0.98, error: null, evidence: [],
        },
      },
      recentRuns: [],
    };
    snapshot.recentRuns = [snapshot.latestRun!];
    const html = renderExtractionDashboard([snapshot], "abc123", "/tmp/claimrot.db");
    expect(html).toContain('<path d="M9.5 14.5 14.5 9.5"/>');
    expect(html).toContain("Run now");
    expect(html).toContain("Test extraction");
    expect(html).toContain("Run history · 1");
    expect(html).toContain("&lt;Red Shoe&gt;");
    expect(html).not.toContain("<Red Shoe>");
    expect(html).toContain('const token="abc123"');

    snapshot.monitor.sourceUrl = "javascript:alert(1)";
    expect(renderExtractionDashboard([snapshot], "abc123", "/tmp/claimrot.db"))
      .not.toContain('href="javascript:');
  });
});
