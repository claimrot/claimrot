import { describe, it, expect } from "vitest";
import { isAllowed } from "../../src/net/politeness.js";

const robots = `User-agent: *\nDisallow: /admin\nDisallow: /private/`;

describe("isAllowed", () => {
  it("allows an unlisted path", () => {
    expect(isAllowed(robots, "/tours/whale-watch")).toBe(true);
  });
  it("blocks a disallowed prefix", () => {
    expect(isAllowed(robots, "/private/rates")).toBe(false);
  });
  it("allows everything when robots.txt is absent or empty", () => {
    expect(isAllowed("", "/anything")).toBe(true);
  });

  it("lets a targeted Allow: carve an exception out of a blanket Disallow:", () => {
    const carveOut = `User-agent: *\nDisallow: /private/\nAllow: /private/rates`;
    expect(isAllowed(carveOut, "/private/rates")).toBe(true);   // longest match wins
    expect(isAllowed(carveOut, "/private/other")).toBe(false);  // still under the blanket rule
  });

  it("ignores rules scoped to a named agent that is not the wildcard group", () => {
    const namedOnly = `User-agent: SomeOtherBot\nDisallow: /private/`;
    expect(isAllowed(namedOnly, "/private/rates")).toBe(true); // not our group to obey
  });

  it("scopes correctly when a wildcard group follows a named-agent group", () => {
    const mixed = `User-agent: SomeOtherBot\nDisallow: /only-for-that-bot\nUser-agent: *\nDisallow: /admin`;
    expect(isAllowed(mixed, "/only-for-that-bot")).toBe(true);  // not ours
    expect(isAllowed(mixed, "/admin/settings")).toBe(false);    // ours
  });
});
