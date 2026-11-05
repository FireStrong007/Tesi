import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { migrate } from "../src/lib/db/migrate";
import { oo1Executor, type Oo1Db, type SqlExecutor } from "../src/lib/db/sql";

export async function memoryDb(): Promise<{ db: SqlExecutor; raw: Oo1Db }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlite3 = await (sqlite3InitModule as any)({ print: () => {}, printErr: () => {} });
  const raw = new sqlite3.oo1.DB(":memory:") as Oo1Db;
  migrate(raw);
  return { db: oo1Executor(raw), raw };
}
