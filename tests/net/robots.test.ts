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
});
