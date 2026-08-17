import { describe, it, expect } from "vitest";
import { HostQueue } from "../../src/net/politeness.js";

describe("HostQueue", () => {
  it("never runs two tasks on the same host concurrently", async () => {
    const q = new HostQueue(0);
    let inFlight = 0, maxInFlight = 0;
    const task = async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    };
    await Promise.all(
      Array.from({ length: 5 }, () => q.run("https://a.example/x", task)),
    );
    expect(maxInFlight).toBe(1);
  });

  it("runs different hosts concurrently", async () => {
    const q = new HostQueue(0);
    let inFlight = 0, maxInFlight = 0;
    const task = async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
    };
    await Promise.all([
      q.run("https://a.example/x", task),
      q.run("https://b.example/x", task),
      q.run("https://c.example/x", task),
    ]);
    expect(maxInFlight).toBe(3);
  });

  it("spaces same-host calls by at least the minimum interval", async () => {
    const q = new HostQueue(50);
    const at: number[] = [];
    const stamp = async () => { at.push(Date.now()); };
    await Promise.all([q.run("https://a.example/1", stamp), q.run("https://a.example/2", stamp)]);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(45);
  });

  it("rejects rather than throws on a malformed URL", async () => {
    // Must be a rejection, not a synchronous throw: callers build arrays of
    // run() promises, and a raw throw aborts array construction and kills
    // scheduling for every other host in the batch.
    const q = new HostQueue(0);
    await expect(q.run("not a url", async () => "x")).rejects.toBeInstanceOf(TypeError);
  });

  it("a malformed URL does not disturb scheduling for other hosts", async () => {
    const q = new HostQueue(0);
    const results = await Promise.allSettled([
      q.run("not a url", async () => "bad"),
      q.run("https://a.example/x", async () => "good"),
    ]);
    expect(results[0].status).toBe("rejected");
    expect(results[1]).toMatchObject({ status: "fulfilled", value: "good" });
  });

  it("a throwing task rejects to its own caller while the next same-host task still runs", async () => {
    const q = new HostQueue(0);
    const calls: string[] = [];
    const failing = async () => {
      calls.push("failing");
      throw new Error("boom");
    };
    const succeeding = async () => {
      calls.push("succeeding");
      return "ok";
    };
    const p1 = q.run("https://a.example/x", failing);
    const p2 = q.run("https://a.example/y", succeeding);
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
    expect(calls).toEqual(["failing", "succeeding"]);
  });
});
