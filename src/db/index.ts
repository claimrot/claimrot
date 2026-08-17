import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  // Existing DBs predate last_checked_at; ALTER is a no-op error if present.
  try {
    db.exec("ALTER TABLE claims ADD COLUMN last_checked_at TEXT");
  } catch (e) {
    // "duplicate column name" is the expected no-op on an already-migrated DB.
    // Anything else is a real failure and must not be swallowed.
    if (!/duplicate column/i.test((e as Error).message)) throw e;
  }
  return db;
}
