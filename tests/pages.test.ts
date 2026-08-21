import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const landingPath = fileURLToPath(new URL("../docs/index.html", import.meta.url));
const demoPath = fileURLToPath(new URL("../docs/demo/index.html", import.meta.url));

describe("GitHub Pages integration", () => {
  it("links the marketing page to the published dashboard in its nav, hero, and footer", () => {
    const landing = readFileSync(landingPath, "utf8");
    expect(landing.match(/href="demo\/"/g)).toHaveLength(3);
    expect(landing).toContain("View dashboard");
    expect(landing).toContain("View a sample report");
  });

  it("publishes a self-contained sanitized dashboard with the shared logo and return link", () => {
    const demo = readFileSync(demoPath, "utf8");
    expect(demo).toMatch(/^<!doctype html>/);
    expect(demo).toContain("Are the claims you publish still valid?");
    expect(demo).toContain('<span class="brand">');
    expect(demo).toContain('<path d="M9.5 14.5 14.5 9.5"/>');
    expect(demo).toContain('href="https://claimrot.github.io/claimrot/"');
    expect(demo).toContain("Senior admission on the Ocean Cabin tour is NZ$140.");
    expect(demo).not.toContain("[deliberately");
    expect(demo).not.toContain("heal failed:");
    expect(existsSync(fileURLToPath(new URL("../docs/demo/demo.db", import.meta.url)))).toBe(false);
  });
});
