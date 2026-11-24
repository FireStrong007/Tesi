/** In-memory research server databases (the real SQLite of the browser, sqlite-wasm) for core's tests. */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { oo1Executor, type Oo1Db, type SqlExecutor } from "../src/db/sql";
import { SERVER_SCHEMA } from "../src/server/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sqlite3 = await (sqlite3InitModule as any)({ print: () => {}, printErr: () => {} });

/** An empty Garmin server database (the real schema). */
export function serverDb(): SqlExecutor {
  const raw = new sqlite3.oo1.DB(":memory:") as Oo1Db;
  raw.exec({ sql: SERVER_SCHEMA });
  return oo1Executor(raw);
}

/** Adds a participant with one band; returns their ids. */
export async function addParticipant(db: SqlExecutor, name: string) {
  const p = await db.run("INSERT INTO participant (name, api_key_hash, created_at) VALUES (?, ?, 0)", [name, `hash-${name}`]);
  const pid = p.lastInsertRowid;
  const d = await db.run("INSERT INTO device (participant_id, identifier, name, manufacturer, type, type_name) VALUES (?, ?, 'vívosmart 5', 'Garmin', 0, 'GARMIN')", [pid, `serial-${name}`]);
  return { pid, did: d.lastInsertRowid };
}
