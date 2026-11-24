/**
 * The only module that reads the research database's tables. Health tables are read only through
 * readRows/devicesOf, always with `USER_ID = ?` / `participant_id = ?` bound to the participant
 * of the session (the routes never take it from the request). Table and column names come from
 * core's DATASETS and from the database's own schema, never from the request.
 * The administrator's overview reads only participant codes and device dates, no health data.
 */
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { DataTable, Dataset } from "@bridge/core/datasets";

export interface TableInfo extends DataTable {
  columns: string[];
  /** primary key columns after USER_ID, in key order (the download order and the page cursor) */
  key: string[];
  /** BLOB columns (sent as base64) */
  blobs: string[];
}

export class BadRequest extends Error {}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

const cache = new WeakMap<DatabaseSync, Map<string, TableInfo>>();

/** The participant-downloadable tables of a dataset, with columns and keys read from the copy. */
export function tableInfos(db: DatabaseSync, ds: Dataset): Map<string, TableInfo> {
  let infos = cache.get(db);
  if (!infos) {
    infos = new Map();
    for (const t of ds.dataTables) {
      const cols = db.prepare("SELECT name, type, pk FROM pragma_table_info(?)").all(t.name) as { name: string; type: string; pk: number }[];
      if (!cols.length) continue;
      const key = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      if (key[0] !== "USER_ID") throw new Error(`${t.name}: la chiave primaria non comincia con USER_ID`);
      infos.set(t.name, { ...t, columns: cols.map((c) => c.name), key: key.slice(1), blobs: cols.filter((c) => c.type.toUpperCase() === "BLOB").map((c) => c.name) });
    }
    cache.set(db, infos);
  }
  return infos;
}

export const MAX_PAGE = 20_000;
export const DEFAULT_PAGE = 5_000;

const encodeCursor = (v: SQLOutputValue[]) => Buffer.from(JSON.stringify(v)).toString("base64url");
function decodeCursor(s: string, n: number): (number | string)[] {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch {
    throw new BadRequest("Cursore non valido");
  }
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === "number" || typeof x === "string")) throw new BadRequest("Cursore non valido");
  return v;
}

export interface Page {
  table: string;
  columns: string[];
  /** BLOB columns, base64 in the rows */
  blobs: string[];
  rows: unknown[][];
  /** cursor for the next page, null on the last one */
  next: string | null;
}

/**
 * One page of a participant's rows of a table, in key order: rows with time ≥ since (in the table's
 * unit), after the cursor of the previous page.
 */
export function readRows(db: DatabaseSync, info: TableInfo, participantId: number, opts: { device?: number; since?: number; after?: string; limit?: number } = {}): Page {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_PAGE)), MAX_PAGE);
  const where = [`USER_ID = ?`];
  const params: (number | string)[] = [participantId];
  if (opts.device != null) {
    if (!Number.isInteger(opts.device)) throw new BadRequest("Parametro device non valido");
    where.push("DEVICE_ID = ?");
    params.push(opts.device);
  }
  if (opts.since != null) {
    if (!Number.isFinite(opts.since)) throw new BadRequest("Parametro since non valido");
    where.push(`${q(info.time)} >= ?`);
    params.push(opts.since);
  }
  if (opts.after) {
    where.push(`(${info.key.map(q).join(", ")}) > (${info.key.map(() => "?").join(", ")})`);
    params.push(...decodeCursor(opts.after, info.key.length));
  }
  const sql = `SELECT ${info.columns.map(q).join(", ")} FROM ${q(info.name)} WHERE ${where.join(" AND ")} ORDER BY ${info.key.map(q).join(", ")} LIMIT ${limit + 1}`;
  const st = db.prepare(sql);
  st.setReturnArrays(true);
  const raw = st.all(...params) as unknown as SQLOutputValue[][];
  const more = raw.length > limit;
  const rows = more ? raw.slice(0, limit) : raw;
  const blobIdx = info.blobs.map((b) => info.columns.indexOf(b));
  const keyIdx = info.key.map((k) => info.columns.indexOf(k));
  const out = rows.map((r) => {
    if (!blobIdx.length) return r;
    const copy = [...r];
    for (const i of blobIdx) if (copy[i] instanceof Uint8Array) copy[i] = Buffer.from(copy[i] as Uint8Array).toString("base64");
    return copy;
  });
  return { table: info.name, columns: info.columns, blobs: info.blobs, rows: out, next: more ? encodeCursor(keyIdx.map((i) => rows[rows.length - 1][i])) : null };
}

export interface DeviceCount {
  device: number;
  count: number;
  /** latest time in the table's unit */
  maxTime: number | null;
}

/**
 * How many rows the participant has in each table, per device, with the latest time: the browser
 * compares them with its copy and downloads a device's table again when they differ.
 */
export function countsOf(db: DatabaseSync, ds: Dataset, participantId: number): Record<string, DeviceCount[]> {
  const out: Record<string, DeviceCount[]> = {};
  for (const info of tableInfos(db, ds).values()) {
    out[info.name] = db
      .prepare(`SELECT DEVICE_ID AS device, count(*) AS count, max(${q(info.time)}) AS maxTime FROM ${q(info.name)} WHERE USER_ID = ? GROUP BY DEVICE_ID ORDER BY DEVICE_ID`)
      .all(participantId) as unknown as DeviceCount[];
  }
  return out;
}

/** The participant's own devices, only the dataset's shown columns. */
export function devicesOf(db: DatabaseSync, ds: Dataset, participantId: number) {
  return db.prepare(`SELECT ${ds.deviceColumns.map(q).join(", ")} FROM device WHERE participant_id = ? ORDER BY id`).all(participantId) as Record<string, SQLOutputValue>[];
}

export interface ParticipantOverview {
  id: number;
  code: string;
  createdAt: number;
  devices: Record<string, SQLOutputValue>[];
  lastMeasurementAt: number | null;
  lastUploadAt: number | null;
}

/** For the administrator: codes, devices and dates only (no health data, no keys or tokens). */
export function participantsOverview(db: DatabaseSync, ds: Dataset): ParticipantOverview[] {
  const people = db.prepare("SELECT id, name, created_at FROM participant ORDER BY name").all() as { id: number; name: string; created_at: number }[];
  const devices = db.prepare(`SELECT participant_id, ${ds.deviceColumns.map(q).join(", ")} FROM device ORDER BY id`).all() as (Record<string, SQLOutputValue> & { participant_id: number })[];
  const max = (v: (SQLOutputValue | undefined)[]) => v.reduce<number | null>((m, x) => (typeof x === "number" && (m == null || x > m) ? x : m), null);
  return people.map((p) => {
    const mine = devices.filter((d) => d.participant_id === p.id).map(({ participant_id: _, ...d }) => d);
    return {
      id: p.id,
      code: p.name,
      createdAt: p.created_at,
      devices: mine,
      lastMeasurementAt: max(mine.map((d) => d.last_measurement_at)),
      lastUploadAt: max(mine.map((d) => d.last_successful_upload_at)),
    };
  });
}

export const participantExists = (db: DatabaseSync, id: number) => !!db.prepare("SELECT 1 FROM participant WHERE id = ?").get(id);
export const participantCode = (db: DatabaseSync, id: number) => (db.prepare("SELECT name FROM participant WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? null;
