import { describe, it, expect } from "vitest";
import { nextCheckAt } from "../../src/engine/schedule.js";
import type { Claim } from "../../src/model/types.js";

const now = new Date("2026-08-17T00:00:00Z");
const claim = (o: Partial<Claim> = {}): Claim => ({
  id: "c1", documentId: "d", text: "t", sourceUrl: "https://x.example/p",
  ingestedAt: "", checkedAt: "2026-08-17", volatile: true, expiresAt: null,
  status: "active", ...o,
});
const days = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 86_400_000);

describe("nextCheckAt", () => {
  it("checks volatile claims weekly", () => {
    expect(days(nextCheckAt(claim(), "HOLDS", 0, now), now)).toBe(7);
  });

  it("checks non-volatile claims quarterly", () => {
    expect(days(nextCheckAt(claim({ volatile: false }), "HOLDS", 0, now), now)).toBe(90);
  });

  it("front-runs a self-declared expiry", () => {
    // Whale Watch: "valid to 30 September 2026" — predictable drift.
    const c = claim({ expiresAt: "2026-10-01T00:00:00Z" });
    const at = nextCheckAt(c, "HOLDS", 0, now);
    expect(at.toISOString().slice(0, 10)).toBe("2026-09-30");
  });

  it("backs off exponentially on UNVERIFIABLE, capped at 30 days", () => {
    expect(days(nextCheckAt(claim(), "UNVERIFIABLE", 1, now), now)).toBe(1);
    expect(days(nextCheckAt(claim(), "UNVERIFIABLE", 2, now), now)).toBe(3);
    expect(days(nextCheckAt(claim(), "UNVERIFIABLE", 3, now), now)).toBe(9);
    expect(days(nextCheckAt(claim(), "UNVERIFIABLE", 9, now), now)).toBe(30);
  });

  it("checks again the day AFTER a self-declared expiry", () => {
    // The eve confirms the old value; only this catches the new one. Without it
    // a predictable change is found up to 6 days late on the ordinary cadence.
    const c = claim({ expiresAt: "2026-10-01T00:00:00Z" });
    const justBeforeExpiry = new Date("2026-09-30T12:00:00Z");
    const at = nextCheckAt(c, "HOLDS", 0, justBeforeExpiry);
    expect(at.toISOString().slice(0, 10)).toBe("2026-10-02");
  });

  it("returns to the ordinary cadence once the expiry is fully past", () => {
    const c = claim({ expiresAt: "2026-10-01T00:00:00Z" });
    const wellAfter = new Date("2026-10-05T00:00:00Z");
    const at = nextCheckAt(c, "HOLDS", 0, wellAfter);
    expect(Math.round((at.getTime() - wellAfter.getTime()) / 86_400_000)).toBe(7);
  });
});
