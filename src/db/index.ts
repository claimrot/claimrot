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
  try { db.exec("ALTER TABLE claims ADD COLUMN last_checked_at TEXT"); } catch { /* already there */ }
  return db;
}
