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
});
