import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/index.js";
import { renderDashboard } from "../../src/report/dashboard.js";

function addClaim(db: ReturnType<typeof openDb>, id: string, status = "active") {
  db.prepare(
    `INSERT INTO claims (id,document_id,text,source_url,ingested_at,checked_at,volatile,status)
     VALUES (?,?,?,?,?,?,0,?)`,
  ).run(id, "doc", `Claim ${id}`, `https://old.example/${id}`, "2026-08-01", "2026-08-01", status);
}

describe("dashboard report states", () => {
  it("distinguishes an empty database from an ingested claim that has not been checked", () => {
    const empty = renderDashboard(openDb(":memory:"));
    expect(empty).toContain("No claims ingested yet");
    expect(empty).toContain("No check history yet");
    expect(empty).toContain('class="health-ring health-ring--empty"');
    expect(empty).toContain('<strong>—</strong><small>No checks yet</small>');

    const db = openDb(":memory:");
    addClaim(db, "fresh");
    const unchecked = renderDashboard(db);
    expect(unchecked).toContain("Not checked");
    expect(unchecked).toContain("Never");
    expect(unchecked).toContain('data-group="unchecked"');
    expect(unchecked).toContain('data-filter="unchecked"');
  });

  it("renders an unknown stored verdict safely without using it as a CSS class", () => {
    const db = openDb(":memory:");
    addClaim(db, "future");
    db.prepare(
      `INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at)
       VALUES ('v','','future','FUTURE<script>',0.4,'{}','2026-08-16')`,
    ).run();

    const html = renderDashboard(db);
    expect(html).toContain("Unknown status");
    expect(html).toContain("status--unknown");
    expect(html).not.toContain("status--future<script>");
    expect(html).not.toContain("<script>&gt;");
  });

  it("counts MOVED as currently valid and labels its destination with host and path", () => {
    const db = openDb(":memory:");
    addClaim(db, "moved");
    db.prepare(
      `INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at)
       VALUES ('v','','moved','MOVED',0.9,?,'2026-08-16')`,
    ).run(JSON.stringify({ reason: "The page moved", foundAt: "https://new.example/prices/adult" }));

    const html = renderDashboard(db);
    expect(html).toContain('<strong>100%</strong><small>Currently valid</small>');
    expect(html).toContain("new.example/prices/adult");
  });

  it("surfaces two consecutive ambiguous results as a human escalation", () => {
    const db = openDb(":memory:");
    addClaim(db, "ambiguous");
    const insert = db.prepare(
      `INSERT INTO verdicts
         (id,check_id,claim_id,assertion_id,verdict,confidence,evidence_json,created_at)
       VALUES (?,'','ambiguous','ambiguous:a1','AMBIGUOUS',0.5,'{}',?)`,
    );
    insert.run("v1", "2026-08-10");
    insert.run("v2", "2026-08-16");

    expect(renderDashboard(db)).toContain("Ambiguous twice running · human review required");
  });
});
