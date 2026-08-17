import { describe, it, expect } from "vitest";
import { checkAssertion } from "../../src/engine/check.js";
import type { EngineDeps } from "../../src/engine/check.js";
import type { Assertion } from "../../src/model/types.js";
import type { CollectRunResult } from "../../src/collect/types.js";

const a: Assertion = {
  id: "a1", claimId: "c1", field: "adult_price", op: "eq",
  valueNum: 175, valueText: null, valueMax: null, unit: "NZD", tolerance: null,
  anchorLabel: "Adult", anchorContext: "Ocean Cabin", anchorPath: "",
};

const CITED = "https://x.example/old-tour";
const NEW = "https://x.example/pricing";

const cand = (value: number, label = "Adult") =>
  ({ value, valueText: null, unit: "NZD", label, context: "Ocean Cabin", path: "" });

const result = (url: string, cands: any[]): CollectRunResult => ({
  status: cands.length ? "ok" : "empty",
  record: {
    url, fetchedAt: "t", collectorVersion: "v", pageSignature: "",
    fields: cands.length ? { adult_price: cands } : {},
  },
});

const healed = async () => ({ status: "healed" as const, collectorVersion: "v2" });

/** Blind at the cited URL; `elsewhere` decides what each other URL serves. */
const deps = (
  elsewhere: Record<string, any[]>,
  successors?: EngineDeps["successors"],
): EngineDeps => ({
  run: async (_id, url) => result(url, url === CITED ? [] : elsewhere[url] ?? []),
  heal: healed,
  successors,
});

const propose = (...urls: string[]) =>
  async () => urls.map((url) => ({ url, why: "linked from the cited page" }));

describe("relocation", () => {
  it("MOVED when the anchor resolves elsewhere with the value intact", async () => {
    const r = await checkAssertion(a, "c_1", CITED,
      deps({ [NEW]: [cand(175)] }, propose(NEW)));
    expect(r.verdict).toBe("MOVED");
    expect(r.foundAt).toBe(NEW);
    expect(r.reason).toContain(NEW);
  });

  it("DRIFTED, not MOVED, when the relocated value also changed", async () => {
    const r = await checkAssertion(a, "c_1", CITED,
      deps({ [NEW]: [cand(185)] }, propose(NEW)));
    expect(r.verdict).toBe("DRIFTED");
    expect(r.foundAt).toBe(NEW);
  });

  it("falls through to REMOVED when no successor holds the anchor", async () => {
    const r = await checkAssertion(a, "c_1", CITED,
      deps({ [NEW]: [] }, propose(NEW)));
    expect(r.verdict).toBe("REMOVED");
    expect(r.foundAt).toBeUndefined();
  });

  it("is REMOVED, exactly as before, when no successor search is wired in", async () => {
    const r = await checkAssertion(a, "c_1", CITED, deps({}));
    expect(r.verdict).toBe("REMOVED");
  });

  it("takes the first successor that actually resolves, skipping ones that do not", async () => {
    const tried: string[] = [];
    const d = deps({ "https://x.example/b": [cand(175)] }, propose("https://x.example/a", "https://x.example/b"));
    const r = await checkAssertion(a, "c_1", CITED, {
      ...d,
      run: async (id, url) => { tried.push(url); return d.run(id, url); },
    });
    expect(r.verdict).toBe("MOVED");
    expect(r.foundAt).toBe("https://x.example/b");
    expect(tried).toContain("https://x.example/a");
  });

  it("declines relocation entirely when the successor's anchor is ambiguous", async () => {
    // Two equally-good "Adult" candidates on the proposed page, so the
    // resolver returns AMBIGUOUS. That is not evidence of a move — and it must
    // not be laundered into a DRIFTED either, which is what dropping the
    // HOLDS/DRIFTED guard would do. The only honest answer is REMOVED.
    const r = await checkAssertion(a, "c_1", CITED,
      deps({ [NEW]: [cand(175), cand(190)] }, propose(NEW)));
    expect(r.verdict).toBe("REMOVED");
    expect(r.foundAt).toBeUndefined();
  });

  it("never relocates on a value match alone — the label still has to anchor", async () => {
    // Right number, wrong label: searching for 175 would call this a move.
    const r = await checkAssertion(a, "c_1", CITED,
      deps({ [NEW]: [cand(175, "Senior")] }, propose(NEW)));
    expect(r.verdict).toBe("REMOVED");
  });

  it("paces every successor request — a slot must not burst at one host", async () => {
    // HostQueue spaces queue SLOTS, not requests inside one. Relocation adds
    // several, so without a pace hook per attempt the whole search fires at
    // full speed behind a single slot's spacing.
    const order: string[] = [];
    const d = deps({ "https://x.example/c": [cand(175)] },
      propose("https://x.example/a", "https://x.example/b", "https://x.example/c"));
    await checkAssertion(a, "c_1", CITED, {
      ...d,
      run: async (id, url) => { order.push(`run ${url}`); return d.run(id, url); },
      pace: async () => { order.push("pace"); },
    });
    const successorSteps = order.slice(order.indexOf("pace"));
    // Strictly alternating: every successor fetch is preceded by a wait.
    expect(successorSteps).toEqual([
      "pace", "run https://x.example/a",
      "pace", "run https://x.example/b",
      "pace", "run https://x.example/c",
    ]);
  });

  it("does not search for a successor while the value is still on the cited page", async () => {
    let searched = false;
    const r = await checkAssertion(a, "c_1", CITED, {
      run: async () => result(CITED, [cand(175)]),
      heal: healed,
      successors: async () => { searched = true; return [{ url: NEW, why: "" }]; },
    });
    expect(r.verdict).toBe("HOLDS");
    expect(searched).toBe(false);
  });
});
