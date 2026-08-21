import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function addColumn(db: Database.Database, table: string, definition: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (e) {
    if (!/duplicate column/i.test((e as Error).message)) throw e;
  }
}

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  addColumn(db, "claims", "last_checked_at TEXT");
  addColumn(db, "verdicts", "assertion_id TEXT");

  // The CLI historically embedded assertion IDs at the front of verdict IDs.
  // Recover that relationship where possible; unmatched third-party/legacy
  // rows remain one backwards-compatible history stream per claim.
  db.exec(
    `UPDATE verdicts AS v
     SET assertion_id = (
       SELECT a.id FROM assertions a
       WHERE a.claim_id = v.claim_id
         AND substr(v.id, 1, length(a.id) + 1) = a.id || ':'
       ORDER BY length(a.id) DESC LIMIT 1
     )
     WHERE v.assertion_id IS NULL`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_verdicts_assertion
     ON verdicts(claim_id, assertion_id, created_at)`,
  );
  return db;
}
