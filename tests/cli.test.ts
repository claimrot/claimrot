import { describe, it, expect } from "vitest";
import {
  buildProgram, UPDATE_LAST_CHECKED_SQL, repeatAmbiguousClaims, fetchRobots, ROBOTS_UA,
  runGeneric, isGenericCollector, GENERIC_COLLECTOR_ID,
} from "../src/cli.js";
import { openDb } from "../src/db/index.js";

describe("cli", () => {
  it("registers every documented command", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names.sort()).toEqual(["check", "ingest", "report", "study"]);
  });

  it("check's own update statement advances last_checked_at without disturbing checked_at", () => {
    // checked_at is the SOURCE's verification date and is what the half-life
    // study measures against. Advancing it on every run zeroes every age bucket
    // and makes the study report 0% drift at every horizon. This asserts the
    // EXACT statement cli.ts prepares in `check` — a hand-written duplicate
    // here would not catch a regression if that statement were changed back
    // to target checked_at.
    expect(UPDATE_LAST_CHECKED_SQL).toMatch(/\bSET\s+last_checked_at\s*=/i);
    expect(UPDATE_LAST_CHECKED_SQL).not.toMatch(/\bSET\s+checked_at\s*=/i);

    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO claims (id,document_id,text,source_url,ingested_at,checked_at,volatile,status)
       VALUES ('c1','d','t','https://x.example/','2026-08-01','2026-07-28',1,'active')`,
    ).run();
    db.prepare(UPDATE_LAST_CHECKED_SQL).run("2026-08-17", "c1");
    const row = db.prepare(`SELECT checked_at, last_checked_at FROM claims WHERE id='c1'`).get() as any;
    expect(row.checked_at).toBe("2026-07-28");        // untouched
    expect(row.last_checked_at).toBe("2026-08-17");
  });
});

describe("fetchRobots", () => {
  it("identifies itself when fetching robots.txt", async () => {
    // Spec 10: the one raw fetch we make is on the endpoint whose entire purpose
    // is establishing that we behave well. An anonymous hit there is the wrong
    // first impression to give an operator reading their logs.
    const seen: RequestInit[] = [];
    const fakeFetch = async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response("", { status: 200 });
    };
    await fetchRobots("x.example", fakeFetch as unknown as typeof fetch);
    const headers = seen[0].headers as Record<string, string>;
    expect(headers["user-agent"]).toMatch(/claimrot/);
    expect(ROBOTS_UA).toMatch(/claimrot/);
  });

  it("treats a non-ok response as allowed (empty robots.txt)", async () => {
    const fakeFetch = async () => new Response("", { status: 404 });
    const text = await fetchRobots("x.example", fakeFetch as unknown as typeof fetch);
    expect(text).toBe("");
  });

  it("treats a network failure or timeout as allowed, not a silent refusal to check", async () => {
    const fakeFetch = async () => { throw new Error("timeout"); };
    const text = await fetchRobots("x.example", fakeFetch as unknown as typeof fetch);
    expect(text).toBe("");
  });
});

describe("generic collector fallback", () => {
  // registry.ts's fallback for the unmatched 352-host tail returns the literal
  // string "generic", which is not a real Bright Data collector ID. This must
  // route to a direct fetch + JSON-LD read, never to `bdata scraper run`.
  it("routes a 'generic' collector ID to the JSON-LD path", () => {
    expect(isGenericCollector(GENERIC_COLLECTOR_ID)).toBe(true);
    expect(isGenericCollector("c_whalewatch")).toBe(false);
  });

  it("runGeneric extracts JSON-LD via a direct, identified fetch rather than shelling out", async () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","name":"Adult","offers":{"price":175,"priceCurrency":"NZD"}}
    </script>`;
    const seenInit: RequestInit[] = [];
    const fakeFetch = async (_u: string | URL | Request, init?: RequestInit) => {
      seenInit.push(init ?? {});
      return new Response(html, { status: 200 });
    };
    const result = await runGeneric(
      "https://x.example/tour", "adult_price", fakeFetch as unknown as typeof fetch,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.record.fields.adult_price[0].value).toBe(175);
      expect(result.record.collectorVersion).toBe(GENERIC_COLLECTOR_ID);
    }
    // Identified, per spec §10 — same requirement as fetchRobots above.
    const headers = seenInit[0].headers as Record<string, string>;
    expect(headers["user-agent"]).toMatch(/claimrot/);
  });

  it("a page with no JSON-LD offers is a genuine empty, not an error", async () => {
    const fakeFetch = async () => new Response("<html><body>no offers here</body></html>", { status: 200 });
    const result = await runGeneric(
      "https://x.example/tour", "adult_price", fakeFetch as unknown as typeof fetch,
    );
    expect(result.status).toBe("empty");
  });

  it("a fetch failure is OUR blindness (error), never evidence the value is gone (empty)", async () => {
    // Getting this backwards would let a network blip report as a deleted claim.
    const fakeFetch = async () => { throw new Error("network blip"); };
    const result = await runGeneric(
      "https://x.example/tour", "adult_price", fakeFetch as unknown as typeof fetch,
    );
    expect(result.status).toBe("error");
  });

  it("a non-2xx response is also 'error', not 'empty'", async () => {
    const fakeFetch = async () => new Response("", { status: 503 });
    const result = await runGeneric(
      "https://x.example/tour", "adult_price", fakeFetch as unknown as typeof fetch,
    );
    expect(result.status).toBe("error");
  });
});

describe("repeatAmbiguousClaims", () => {
  const insertVerdict = (db: ReturnType<typeof openDb>, claimId: string, verdict: string, createdAt: string) =>
    db.prepare(
      `INSERT INTO verdicts (id,check_id,claim_id,verdict,confidence,evidence_json,created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(`${claimId}:${createdAt}`, "", claimId, verdict, 0.5, "{}", createdAt);

  it("flags a claim whose two most recent verdicts are both AMBIGUOUS", () => {
    const db = openDb(":memory:");
    insertVerdict(db, "c1", "AMBIGUOUS", "2026-08-01T00:00:00Z");
    insertVerdict(db, "c1", "AMBIGUOUS", "2026-08-08T00:00:00Z");
    expect(repeatAmbiguousClaims(db)).toContain("c1");
  });

  it("does not flag AMBIGUOUS followed by HOLDS", () => {
    const db = openDb(":memory:");
    insertVerdict(db, "c2", "AMBIGUOUS", "2026-08-01T00:00:00Z");
    insertVerdict(db, "c2", "HOLDS", "2026-08-08T00:00:00Z");
    expect(repeatAmbiguousClaims(db)).not.toContain("c2");
  });
});
