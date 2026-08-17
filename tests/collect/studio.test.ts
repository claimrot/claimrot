import { describe, it, expect } from "vitest";
import { runCollector, healCollector, flagBlobCandidates } from "../../src/collect/studio.js";
import type { Exec } from "../../src/collect/types.js";

const fakeExec = (stdout: string, exitCode = 0): Exec => async () => ({ stdout, exitCode });

const okPayload = JSON.stringify([{
  url: "https://example.com/t",
  fetched_at: "2026-08-17T09:00:00Z",
  collector_version: "c_abc@4",
  fields: {
    adult_price: [
      { value: 175, unit: "NZD", label: "Adult", context: "Ocean Cabin", path: "div>td" },
    ],
  },
}]);

describe("runCollector", () => {
  it("parses a populated record as ok", async () => {
    const r = await runCollector("c_abc", "https://example.com/t", { exec: fakeExec(okPayload) });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.record.fields.adult_price[0].label).toBe("Adult");
  });

  it("reports empty — not error — when the run succeeds with no candidates", async () => {
    const payload = JSON.stringify([{ url: "u", fetched_at: "t", collector_version: "v", fields: {} }]);
    const r = await runCollector("c_abc", "u", { exec: fakeExec(payload) });
    expect(r.status).toBe("empty");
  });

  it("reports error on a non-zero exit", async () => {
    const r = await runCollector("c_abc", "u", { exec: fakeExec("boom", 1) });
    expect(r.status).toBe("error");
  });

  it("reports error on unparseable output rather than pretending it is empty", async () => {
    const r = await runCollector("c_abc", "u", { exec: fakeExec("<html>502</html>") });
    expect(r.status).toBe("error");
  });
});

// The exact payload probe A returned from the live API on 2026-08-17.
const probePayload = JSON.stringify([{
  prices: [
    { price_value: 175, currency: "NZD", label: "Adult", heading: "Ocean Cabin Pricing:" },
    { price_value: 60, currency: "NZD", label: "Child (3yrs-15yrs)", heading: "Ocean Cabin Pricing:" },
  ],
  input: { url: "https://whalewatch.co.nz/your-experience/our-tours/whale-watch-tour/" },
}]);

describe("runCollector — real probe-A payload", () => {
  it("maps the collector's own field names onto our Candidate shape", async () => {
    const r = await runCollector("c_abc", "u", { exec: fakeExec(probePayload) });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const [adult] = r.record.fields.prices;      // field name is the COLLECTOR's choice
    expect(adult.value).toBe(175);               // from price_value
    expect(adult.unit).toBe("NZD");              // from currency
    expect(adult.context).toBe("Ocean Cabin Pricing:"); // from heading
    expect(adult.path).toBe("");                 // real collectors emit no path
  });

  it("does not treat the `input` echo as a candidate field", async () => {
    const r = await runCollector("c_abc", "u", { exec: fakeExec(probePayload) });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(Object.keys(r.record.fields)).toEqual(["prices"]);
  });
});

describe("healCollector", () => {
  it("surfaces the approval envelope", async () => {
    const env = JSON.stringify({ status: "awaiting_approval", preview_result: { adult_price: [] } });
    const r = await healCollector("c_abc", "prompt", { exec: fakeExec(env) });
    expect(r.status).toBe("awaiting_approval");
  });

  it("reports healed only when completed_steps proves the template persisted", async () => {
    const env = JSON.stringify({
      status: "done", collector_id: "c_abc",
      completed_steps: ["planner", "user_approval", "save_new_template"],
    });
    const r = await healCollector("c_abc", "prompt", { autoApprove: true, exec: fakeExec(env) });
    expect(r.status).toBe("healed");
  });

  it('treats status "done" WITHOUT save_new_template as a failure', async () => {
    // Probe C: this is the silent-discard case. status says "done", the heal is
    // thrown away, and nothing else in the envelope complains.
    const env = JSON.stringify({
      status: "done", collector_id: "c_abc",
      completed_steps: ["planner", "user_approval"],
    });
    const r = await healCollector("c_abc", "prompt", { exec: fakeExec(env) });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/save_new_template/);
  });
});

describe("flagBlobCandidates", () => {
  it("drops a candidate whose label matches several distinct anchors", () => {
    const anchors = ["Adult", "Child", "Senior"];
    const blob = { value: 175, valueText: null, unit: "NZD", label: "Adult Child Senior", context: "", path: "" };
    const good = { ...blob, label: "Adult (16+)" };
    const kept = flagBlobCandidates([blob, good], anchors);
    expect(kept).toHaveLength(1);
    expect(kept[0].label).toBe("Adult (16+)");   // a qualifier is NOT a blob
  });
});
