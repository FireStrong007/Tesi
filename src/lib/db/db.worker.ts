/// <reference lib="webworker" />
/**
 * SQLite running in a dedicated worker, persisted in the Origin Private File System
 * through the "opfs-sahpool" VFS (no COOP/COEP headers needed, works on Chrome Android).
 * Falls back to an in-memory database when OPFS is unavailable (e.g. private windows).
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { checkSchema, migrate, type SchemaRepair } from "./migrate";
import { oo1All, oo1Batch, oo1Run, type Oo1Db, type SqlParam, type Statement } from "./sql";

export type WorkerRequest =
  | { id: number; op: "init" }
  | { id: number; op: "all"; sql: string; params?: SqlParam[]; scratch?: boolean }
  | { id: number; op: "run"; sql: string; params?: SqlParam[]; scratch?: boolean }
  | { id: number; op: "batch"; statements: Statement[]; scratch?: boolean }
  | { id: number; op: "export" }
  | { id: number; op: "import"; bytes: Uint8Array }
  | { id: number; op: "wipe" };

export interface InitInfo {
  persistent: boolean;
  version: string;
  file: string;
  /** what the startup schema check found missing and repaired (empty when the schema is complete) */
  repairs: SchemaRepair[];
}

const DB_FILE = "/vitabridge.sqlite3";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlite3: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any = null;
let db: Oo1Db | null = null;
/** a separate in-memory database for computations that need other tables (e.g. the server format) */
let scratchDb: Oo1Db | null = null;
let info: InitInfo | null = null;

async function open(): Promise<InitInfo> {
  if (info) return info;
  sqlite3 = await sqlite3InitModule();
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: "vitabridge-pool", initialCapacity: 6 });
    db = new pool.OpfsSAHPoolDb(DB_FILE) as Oo1Db;
    info = { persistent: true, version: sqlite3.version.libVersion, file: DB_FILE, repairs: [] };
  } catch (e) {
    console.warn("OPFS non disponibile, uso un database in memoria", e);
    db = new sqlite3.oo1.DB(":memory:") as Oo1Db;
    info = { persistent: false, version: sqlite3.version.libVersion, file: ":memory:", repairs: [] };
  }
  migrate(db);
  info.repairs = verify(db);
  return info;
}

/** Startup schema check against a fresh in-memory copy of the schema. */
function verify(d: Oo1Db): SchemaRepair[] {
  const fresh = new sqlite3.oo1.DB(":memory:") as Oo1Db;
  try {
    return checkSchema(d, fresh);
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fresh as any).close();
  }
}

function reopen() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any)?.close();
  db = pool ? (new pool.OpfsSAHPoolDb(DB_FILE) as Oo1Db) : (new sqlite3.oo1.DB(":memory:") as Oo1Db);
  migrate(db);
  if (info) info.repairs = verify(db);
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    let result: unknown;
    if (req.op === "init") result = await open();
    else {
      if (!db) await open();
      const scratch = "scratch" in req && req.scratch;
      if (scratch) scratchDb ??= new sqlite3.oo1.DB(":memory:") as Oo1Db;
      const d = scratch ? scratchDb! : db!;
      switch (req.op) {
        case "all":
          result = oo1All(d, req.sql, req.params);
          break;
        case "run":
          result = oo1Run(d, req.sql, req.params);
          break;
        case "batch":
          oo1Batch(d, req.statements);
          result = null;
          break;
        case "export": {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const bytes: Uint8Array = sqlite3.capi.sqlite3_js_db_export((d as any).pointer);
          (self as unknown as Worker).postMessage({ id: req.id, ok: true, result: bytes }, [bytes.buffer]);
          return;
        }
        case "import": {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (d as any).close();
          if (pool) await pool.importDb(DB_FILE, req.bytes);
          else {
            // in-memory: deserialize into a fresh db
            db = new sqlite3.oo1.DB(":memory:") as Oo1Db;
            const p = sqlite3.wasm.allocFromTypedArray(req.bytes);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rc = sqlite3.capi.sqlite3_deserialize((db as any).pointer, "main", p, req.bytes.length, req.bytes.length,
              sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
            if (rc) throw new Error(`sqlite3_deserialize: ${rc}`);
            migrate(db);
            result = verify(db);
            break;
          }
          reopen();
          result = info?.repairs ?? [];
          break;
        }
        case "wipe": {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (d as any).close();
          if (pool) pool.unlink(DB_FILE);
          reopen();
          result = null;
          break;
        }
      }
    }
    (self as unknown as Worker).postMessage({ id: req.id, ok: true, result });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: req.id, ok: false, error: (e as Error).message ?? String(e) });
  }
};
