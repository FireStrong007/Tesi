/**
 * The browser's copy of the logged-in participant's data: the research server's own health tables
 * (same names, columns, keys and units, only their rows), their devices, and `meta`. The app's
 * tables (activity_sample, sleep_session, …) are built from them by core's adapter
 * (createAppTables), the same code the server and the tests use.
 *
 * The copy belongs to one person of one app (meta.owner): another login wipes it first.
 */
import { DATASETS, type AppId } from "../datasets";
import type { SqlExecutor } from "../db/sql";

export const LOCAL_SCHEMA_VERSION = 1;

/** The CREATE statements of the dataset's health tables, taken from the server's schema. */
export function dataTableStatements(app: AppId): string[] {
  const ds = DATASETS[app];
  const names = new Set(ds.dataTables.map((t) => t.name));
  return ds.schema
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => {
      const m = /^CREATE TABLE IF NOT EXISTS "?(\w+)"?/.exec(s) ?? /^CREATE INDEX IF NOT EXISTS \w+ ON "?(\w+)"?/.exec(s);
      return !!m && names.has(m[1]);
    })
    // the participant and device tables are not copied: no foreign keys to them
    .map((s) => s.replace(/,\s*FOREIGN KEY[^\n]*REFERENCES device\(participant_id, id\)( ON DELETE CASCADE)?/g, ""));
}

const OWN_TABLES = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  // the participant's devices: the columns either app may show (core/datasets.ts deviceColumns)
  `CREATE TABLE IF NOT EXISTS device_info (
    id INTEGER PRIMARY KEY, name TEXT, manufacturer TEXT, type_name TEXT, model TEXT, firmware_version TEXT,
    last_measurement_at INTEGER, last_successful_upload_at INTEGER
  )`,
];

export const DEVICE_COLUMNS = ["id", "name", "manufacturer", "type_name", "model", "firmware_version", "last_measurement_at", "last_successful_upload_at"] as const;

export async function getMeta(db: SqlExecutor, key: string): Promise<string | null> {
  const r = await db.all<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]).catch(() => []);
  return r[0]?.value ?? null;
}
export const setMeta = (db: SqlExecutor, key: string, value: string) => db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);

/** who the copy belongs to */
export const ownerOf = (app: AppId, username: string) => `${app}:${username}`;

/**
 * Creates the tables of a copy for `owner`. Returns false when the database belongs to someone
 * else (or to another schema version): the caller must wipe it and call again.
 */
export async function prepareLocalDb(db: SqlExecutor, app: AppId, owner: string): Promise<boolean> {
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
  if (tables.length) {
    if ((await getMeta(db, "owner")) !== owner || (await getMeta(db, "schema_version")) !== String(LOCAL_SCHEMA_VERSION)) return false;
  }
  await db.batch([...OWN_TABLES, ...dataTableStatements(app)].map((sql) => ({ sql })));
  await setMeta(db, "owner", owner);
  await setMeta(db, "schema_version", String(LOCAL_SCHEMA_VERSION));
  return true;
}
