/** Small helpers to write synthetic server databases with node:sqlite (Node only, never in the browser). */
import { rmSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type SqlRow = Record<string, SQLInputValue>;

/** Inserts rows (all with the same columns) into a table, replacing rows with the same key. */
export function insertRows(db: DatabaseSync, table: string, rows: SqlRow[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const st = db.prepare(`INSERT OR REPLACE INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  for (const r of rows) st.run(...cols.map((c) => r[c] ?? null));
}

/** Runs fn in one transaction. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Creates a new database file (an existing one and its -wal/-shm files are removed first) with the
 * given schema, fills it and leaves it like the research servers' ones: WAL mode, user_version 1.
 */
export function writeDatabaseFile(path: string, schema: string, fill: (db: DatabaseSync) => void) {
  for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(f, { force: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(schema);
    transaction(db, () => fill(db));
    db.exec("PRAGMA user_version = 1");
    db.exec("PRAGMA journal_mode = WAL");
  } finally {
    db.close();
  }
}

/** A deterministic fake "hash" (the real column holds the hash of the phone app's API key). */
export const fakeHash = (r: () => number) => Array.from({ length: 32 }, () => Math.floor(r() * 256).toString(16).padStart(2, "0")).join("");
