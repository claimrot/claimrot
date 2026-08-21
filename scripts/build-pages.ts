import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db/index.js";
import { renderDashboard } from "../src/report/dashboard.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const demoSource = join(projectRoot, "examples", "demo.db");

function polishPublicDemo(db: ReturnType<typeof openDb>): void {
  const updateClaim = db.prepare("UPDATE claims SET text = ? WHERE id = ?");
  updateClaim.run(
    "Adult admission on the Ocean Cabin tour is NZ$170.",
    "kaikoura-whale-watch-demo#adult-drifted",
  );
  updateClaim.run(
    "Senior admission on the Ocean Cabin tour is NZ$140.",
    "kaikoura-whale-watch-demo#senior-blind",
  );

  const history = db.prepare(
    "SELECT id, claim_id AS claimId, evidence_json AS evidence FROM verdicts ORDER BY created_at, rowid",
  ).all() as Array<{ id: string; claimId: string; evidence: string }>;
  const demoDates = [
    "2026-04-04T11:01:06.116Z",
    "2026-05-20T11:01:11.545Z",
    "2026-07-19T11:01:17.005Z",
    "2026-08-10T11:11:45.895Z",
    "2026-08-17T11:12:17.775Z",
  ];
  const updateVerdict = db.prepare(
    "UPDATE verdicts SET created_at = ?, evidence_json = ? WHERE id = ?",
  );
  history.forEach((row, index) => {
    let evidence = row.evidence;
    if (row.claimId === "kaikoura-whale-watch-demo#senior-blind") {
      try {
        const parsed = JSON.parse(evidence) as Record<string, unknown>;
        parsed.reason = "The source did not expose a reliable senior price after the scraper retried.";
        evidence = JSON.stringify(parsed);
      } catch {
        // The report renderer already handles malformed evidence; leave it untouched here.
      }
    }
    updateVerdict.run(demoDates[index] ?? demoDates.at(-1), evidence, row.id);
  });
}

async function renderSanitizedDemo(): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "claimrot-pages-"));
  const databasePath = join(temporary, "demo.db");
  try {
    // openDb performs migrations, so never point it at the tracked fixture.
    await copyFile(demoSource, databasePath);
    const db = openDb(databasePath);
    try {
      polishPublicDemo(db);
      const latest = db.prepare("SELECT MAX(created_at) AS at FROM verdicts").get() as {
        at: string | null;
      };
      const generatedAt = latest.at ? new Date(latest.at) : new Date(0);
      return renderDashboard(db, generatedAt);
    } finally {
      db.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const demo = await renderSanitizedDemo();

  if (process.argv[2] === "--demo-only" || process.argv[2] === "--check-demo") {
    const target = resolve(projectRoot, process.argv[3] ?? "docs/demo/index.html");
    const targetFromDocs = relative(join(projectRoot, "docs"), target);
    if (targetFromDocs.startsWith("..") || isAbsolute(targetFromDocs)) {
      throw new Error("The published demo target must stay inside docs/");
    }
    if (process.argv[2] === "--check-demo") {
      const published = await readFile(target, "utf8");
      if (published !== demo) {
        throw new Error("docs/demo/index.html is stale; run npm run sync:pages-demo");
      }
      console.log("Published dashboard demo matches the renderer and sanitized fixture");
      return;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, demo);
    console.log(`Wrote sanitized dashboard demo to ${target}`);
    return;
  }

  const output = join(projectRoot, "dist", "pages");
  await rm(output, { recursive: true, force: true });
  await cp(join(projectRoot, "docs"), output, { recursive: true });
  await mkdir(join(output, "demo"), { recursive: true });
  await writeFile(join(output, "demo", "index.html"), demo);
  await writeFile(join(output, ".nojekyll"), "");
  console.log(`Built GitHub Pages artifact at ${output}`);
}

await main();
