/**
 * node:sqlite helpers. Research server databases are only ever opened read-only, three times over:
 * a `file:` URI with mode=ro, the driver's readOnly flag and PRAGMA query_only. The URI also has
 * immutable=1: the copies we open never change while open, and SQLite then needs no -wal/-shm
 * files next to them (a WAL database opened read-only would otherwise create them).
 */
import { existsSync, statSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { Dataset } from "@bridge/core/datasets";
import type { SqlExecutor, SqlParam } from "@bridge/core/db/sql";

export class DataFileError extends Error {}

/** Opens a research server database read-only. */
export function openDataFile(path: string): DatabaseSync {
  if (!existsSync(path)) throw new DataFileError(`Il file dei dati non esiste: ${path}`);
  // with immutable=1 SQLite ignores a -wal file: refuse rather than silently miss its rows
  const wal = `${path}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0)
    throw new DataFileError(`Accanto a ${path} c'è un file -wal non vuoto: usa una copia coerente del database (per esempio quella di /admin/backup)`);
  const url = pathToFileURL(path);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  const db = new DatabaseSync(url.href, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  return db;
}

const param = (p: SqlParam): SQLInputValue => (typeof p === "boolean" ? (p ? 1 : 0) : p);

/** The SqlExecutor of core (the interface repo/loadRange use) over a node:sqlite connection. */
export function executor(db: DatabaseSync): SqlExecutor {
  return {
    all: async <T>(sql: string, params: SqlParam[] = []) => db.prepare(sql).all(...params.map(param)) as T[],
    run: async (sql, params = []) => {
      const r = db.prepare(sql).run(...params.map(param));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        for (const s of statements) db.prepare(s.sql).run(...(s.params ?? []).map(param));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

type Columns = Map<string, string[]>;
const columnsOf = (db: DatabaseSync, tables: string[]): Columns =>
  new Map(tables.map((t) => [t, (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t) as { name: string }[]).map((c) => c.name)]));

const expected = new Map<string, Columns>();
/** the columns each table must have, from the dataset's schema built in memory once */
function expectedColumns(ds: Dataset): Columns {
  let cols = expected.get(ds.app);
  if (!cols) {
    const mem = new DatabaseSync(":memory:");
    mem.exec(ds.schema);
    cols = columnsOf(mem, ds.requiredTables);
    mem.close();
    expected.set(ds.app, cols);
  }
  return cols;
}

/**
 * Checks an open copy of a research server database: integrity (PRAGMA quick_check), schema version
 * (user_version = 1) and every table and column the app needs. Throws DataFileError with the reason.
 */
export function checkDataDb(db: DatabaseSync, ds: Dataset) {
  const qc = (db.prepare("PRAGMA quick_check").all() as { quick_check: string }[]).map((r) => r.quick_check);
  if (qc.length !== 1 || qc[0] !== "ok") throw new DataFileError(`Il controllo di integrità non è riuscito: ${qc.slice(0, 3).join("; ")}`);
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version !== 1) throw new DataFileError(`Versione dello schema inattesa: ${version} (attesa 1)`);
  const want = expectedColumns(ds);
  const have = columnsOf(db, ds.requiredTables);
  const missing: string[] = [];
  for (const [table, cols] of want) {
    const got = have.get(table) ?? [];
    if (!got.length) missing.push(table);
    else for (const c of cols) if (!got.includes(c)) missing.push(`${table}.${c}`);
  }
  if (missing.length) throw new DataFileError(`Mancano tabelle o colonne: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}`);
}
