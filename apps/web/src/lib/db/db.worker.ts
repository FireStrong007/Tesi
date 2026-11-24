/// <reference lib="webworker" />
/**
 * SQLite in a dedicated worker: the copy of the logged-in participant's data, persisted in the
 * Origin Private File System through the "opfs-sahpool" VFS (no COOP/COEP headers needed, works on
 * Chrome Android). Falls back to an in-memory database when OPFS is unavailable (private windows):
 * then the copy is downloaded again at every start.
 * `erase` (logout) removes the whole pool directory from OPFS: no file is left on the device.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { oo1All, oo1Batch, oo1Bulk, oo1Run, type Oo1Db, type SqlParam, type Statement } from "@bridge/core/db/sql";

export type WorkerRequest =
  | { id: number; op: "init" }
  | { id: number; op: "all"; sql: string; params?: SqlParam[] }
  | { id: number; op: "run"; sql: string; params?: SqlParam[] }
  | { id: number; op: "batch"; statements: Statement[] }
  | { id: number; op: "bulk"; sql: string; rows: SqlParam[][]; before?: Statement[] }
  | { id: number; op: "wipe" }
  | { id: number; op: "erase" };

export interface InitInfo {
  /** false: in memory only (no OPFS) */
  persistent: boolean;
  version: string;
  file: string;
}

const POOL = "vitabridge-pool";
const DB_FILE = "/bridge-local.sqlite3";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlite3: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any = null;
let db: Oo1Db | null = null;
let info: InitInfo | null = null;

async function open(): Promise<InitInfo> {
  if (info && db) return info;
  sqlite3 ??= await sqlite3InitModule();
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: POOL, initialCapacity: 4 });
    db = new pool.OpfsSAHPoolDb(DB_FILE) as Oo1Db;
    info = { persistent: true, version: sqlite3.version.libVersion, file: DB_FILE };
  } catch (e) {
    console.warn("OPFS non disponibile: i dati restano in memoria fino alla chiusura della pagina", e);
    pool = null;
    db = new sqlite3.oo1.DB(":memory:") as Oo1Db;
    info = { persistent: false, version: sqlite3.version.libVersion, file: ":memory:" };
  }
  return info;
}

function close() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any)?.close();
  db = null;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    let result: unknown = null;
    switch (req.op) {
      case "init":
        result = await open();
        break;
      case "wipe":
        // another person's copy: start from an empty file
        await open();
        close();
        if (pool) pool.unlink(DB_FILE);
        info = null;
        result = await open();
        break;
      case "erase":
        // logout: the file and the pool's directory go away; a new login installs it again
        close();
        if (pool) await pool.removeVfs();
        pool = null;
        info = null;
        break;
      default: {
        if (!db) await open();
        const d = db!;
        if (req.op === "all") result = oo1All(d, req.sql, req.params);
        else if (req.op === "run") result = oo1Run(d, req.sql, req.params);
        else if (req.op === "batch") oo1Batch(d, req.statements);
        else if (req.op === "bulk") oo1Bulk(d, req.sql, req.rows, req.before);
      }
    }
    (self as unknown as Worker).postMessage({ id: req.id, ok: true, result });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: req.id, ok: false, error: (e as Error).message ?? String(e) });
  }
};
