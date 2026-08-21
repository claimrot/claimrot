import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { renderDashboard } from "../../src/report/dashboard.js";

function seed() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO documents (id, uri, title) VALUES (?, ?, ?)").run(
    "d", "file:///facts.json", "Tour prices",
  );
  const claim = db.prepare(
    "INSERT INTO claims (id,document_id,text,source_url,ingested_at,checked_at,volatile,status) VALUES (?,?,?,?,?,?,1,'active')",
  );
  claim.run("c1", "d", "Adult admission is NZ$175.", "https://x.example/p", "2026-08-01", "2026-08-01");
  claim.run("c2", "d", "Child admission is NZ$60.", "https://x.example/q", "2026-08-01", "2026-08-01");
  claim.run("c3", "d", "Senior admission is NZ$40.", "https://x.example/r", "2026-08-01", "2026-08-01");

  const verdict = db.prepare(
    "INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at) VALUES (?,'',?,?,?,?,?)",
  );
  verdict.run("v1-old", "c1", "HOLDS", 1, JSON.stringify({
    chosen: { value: 175, valueText: null, unit: "NZD", label: "Adult" },
    reason: "old result",
  }), "2026-08-10T00:00:00Z");
  verdict.run("v1", "c1", "DRIFTED", 0.95, JSON.stringify({
    chosen: { value: 180, valueText: null, unit: "NZD", label: "Adult" },
    reason: "Adult now reads 180, expected 175",
  }), "2026-08-16T00:00:00Z");
  verdict.run("v2", "c2", "HOLDS", 1, JSON.stringify({
    chosen: { value: 60, valueText: null, unit: "NZD", label: "Child" },
    reason: "Child still satisfies the assertion",
  }), "2026-08-16T00:00:00Z");
  verdict.run("v3", "c3", "UNVERIFIABLE", 0, "not valid json", "2026-08-16T00:00:00Z");
  return db;
}

describe("renderDashboard", () => {
  it("renders a self-contained current-state report with summary, evidence, and filters", () => {
    const html = renderDashboard(seed(), new Date("2026-08-17T12:00:00Z"));

    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
    expect(html).toContain('<span class="brand">');
    expect(html).toContain('<path d="M9.5 14.5 14.5 9.5"/>');
    expect(html).not.toContain('<span class="brand__mark" aria-hidden="true">cr</span>');
    expect(html).toContain('<strong>33%</strong><small>Currently valid</small>');
    expect(html).toContain('<strong>3</strong><small>Monitored</small>');
    expect(html).toContain('<strong>1</strong><small>Need action</small>');
    expect(html).toContain('<strong>1</strong><small>Need review</small>');
    expect(html).toContain('data-filter="action"');
    expect(html).toContain('data-filter="review"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("“Adult” = 180 NZD");
    expect(html).toContain("Adult now reads 180, expected 175");
  });

  it("shows only the latest verdict for each claim", () => {
    const html = renderDashboard(seed());

    expect(html).toContain("Drifted");
    expect(html).not.toContain("old result");
    expect(html.match(/id="claim-c1"/g)).toHaveLength(1);
    expect(html).toContain("Adult now reads 180, expected 175");
  });

  it("survives malformed evidence and explains the missing receipt", () => {
    const html = renderDashboard(seed());

    expect(html).toContain("No reliable current value");
    expect(html).toContain("No explanation was recorded for this check.");
  });

  it("escapes stored content and refuses non-http links", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO claims (id,document_id,text,source_url,ingested_at,checked_at,volatile,status) VALUES (?,?,?,?,?,?,1,'active')",
    ).run("x", "d", '<img src=x onerror="alert(1)">', "javascript:alert(1)", "2026-08-01", "2026-08-01");
    db.prepare(
      "INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at) VALUES ('vx','','x','MOVED',0.8,?,?)",
    ).run(JSON.stringify({ reason: "<script>alert(1)</script>", foundAt: "javascript:alert(2)" }), "2026-08-16T00:00:00Z");

    const html = renderDashboard(db);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('href="javascript:');
  });
});
