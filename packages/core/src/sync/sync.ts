/**
 * Synchronisation of the browser's copy (local-db.ts) with the server (packages/server,
 * /api/data/*), table by
 * table and device by device:
 *  - a device with nothing in the copy: everything is downloaded;
 *  - otherwise its rows from (its latest time − WINDOW_DAYS) on are deleted and downloaded again:
 *    the server's data can arrive late or be replaced, and there is no "modified at" column;
 *  - then the copy's row count per table and device is compared with the server's: when they
 *    differ (e.g. an old period recovered by hand on the server, or an interrupted download) that
 *    device's table is downloaded again in full;
 *  - a device the server no longer has for a table is removed from the copy.
 * If the server's data copy changes during the sync (dataVersion), the whole sync runs once more.
 * If the server reads another data source than the copy's (meta.source), nothing is written:
 * SourceChangedError, and the app wipes the copy and downloads it again.
 */
import type { SqlExecutor, SqlParam, Statement } from "../db/sql";
import { DEVICE_COLUMNS, getMeta, markDirty, setMeta } from "./local-db";

export const WINDOW_DAYS = 3;
export const PAGE_SIZE = 5000;

export interface TableMeta {
  name: string;
  time: string;
  unit: "s" | "ms";
  columns: string[];
  key: string[];
  blobs: string[];
}
export interface DeviceCount {
  device: number;
  count: number;
  maxTime: number | null;
}
export interface CountsResponse {
  counts: Record<string, DeviceCount[]>;
  dataVersion: number;
  dataTakenAt: number | null;
  /** the server's data source (the same fingerprint as /api/auth/me) */
  source?: string;
}
export interface PageResponse {
  columns: string[];
  blobs: string[];
  rows: unknown[][];
  next: string | null;
  dataVersion: number;
}
export type DeviceRow = Record<string, string | number | null>;

/** The server's API as the sync needs it (lib/api.ts in the browser, the server in-process in tests). */
export interface SyncApi {
  tables(): Promise<{ tables: TableMeta[] }>;
  counts(): Promise<CountsResponse>;
  page(table: string, q: { device: number; since?: number; after?: string; limit?: number }): Promise<PageResponse>;
  devices(): Promise<{ devices: DeviceRow[]; dataTakenAt: number | null }>;
}

export interface SyncProgress {
  /** rows downloaded so far */
  rows: number;
  /** rows expected (an estimate for the incremental windows) */
  expected: number;
  table: string;
}

export interface SyncReport {
  rows: number;
  /** "TABLE:device" downloaded in full (first time or after a count mismatch) */
  full: string[];
  /** "TABLE:device" downloaded again because the counts did not match */
  recounted: string[];
  removed: string[];
  ms: number;
  dataTakenAt: number | null;
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const windowOf = (unit: "s" | "ms") => WINDOW_DAYS * 86_400 * (unit === "ms" ? 1000 : 1);
const toSeconds = (t: number, unit: "s" | "ms") => (unit === "ms" ? Math.floor(t / 1000) : t);

const B64 = new Uint8Array(128);
"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("").forEach((c, i) => (B64[c.charCodeAt(0)] = i));
/** standard base64 (the server's BLOB columns) to bytes; core has no atob */
export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64[clean.charCodeAt(i)] << 18) | (B64[clean.charCodeAt(i + 1)] << 12) | ((B64[clean.charCodeAt(i + 2)] ?? 0) << 6) | (B64[clean.charCodeAt(i + 3)] ?? 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

class DataChanged extends Error {}

/** the server now reads another data source than the one the copy was made from */
export class SourceChangedError extends Error {
  constructor() {
    super("I dati del server sono cambiati: la copia sul dispositivo va scaricata di nuovo.");
  }
}

/** Brings the copy in line with the server. The local tables must exist (prepareLocalDb). */
export async function syncCopy(db: SqlExecutor, api: SyncApi, opts: { onProgress?: (p: SyncProgress) => void; now?: () => number } = {}): Promise<SyncReport> {
  try {
    return await syncOnce(db, api, opts);
  } catch (e) {
    // the server switched to a newer data copy while we were downloading: start again from its counts
    if (e instanceof DataChanged) return syncOnce(db, api, opts);
    throw e;
  }
}

async function syncOnce(db: SqlExecutor, api: SyncApi, opts: { onProgress?: (p: SyncProgress) => void; now?: () => number }): Promise<SyncReport> {
  const started = Date.now();
  const now = opts.now ?? Date.now;
  const { tables } = await api.tables();
  const server = await api.counts();
  // before anything is written: the copy must come from the same data source
  const source = await getMeta(db, "source");
  if (server.source != null && source != null && server.source !== source) throw new SourceChangedError();
  const report: SyncReport = { rows: 0, full: [], recounted: [], removed: [], ms: 0, dataTakenAt: server.dataTakenAt };

  // the tasks: one per table and device
  type Task = { t: TableMeta; device: number; server: DeviceCount; since: number | null };
  const tasks: Task[] = [];
  let expected = 0;
  for (const t of tables) {
    const local = await db.all<{ device: number; n: number; minTime: number | null; maxTime: number | null }>(
      `SELECT DEVICE_ID AS device, count(*) AS n, min(${q(t.time)}) AS minTime, max(${q(t.time)}) AS maxTime FROM ${q(t.name)} GROUP BY DEVICE_ID`,
    );
    const remote = server.counts[t.name] ?? [];
    for (const l of local)
      if (!remote.some((r) => r.device === l.device)) {
        // the app's tables change from that device's first day on
        await markDirty(db, l.minTime == null ? "all" : toSeconds(l.minTime, t.unit));
        await db.run(`DELETE FROM ${q(t.name)} WHERE DEVICE_ID = ?`, [l.device]);
        report.removed.push(`${t.name}:${l.device}`);
      }
    for (const r of remote) {
      const l = local.find((x) => x.device === r.device);
      const since = l && l.n > 0 && l.maxTime != null ? l.maxTime - windowOf(t.unit) : null;
      tasks.push({ t, device: r.device, server: r, since });
      // the progress bar counts the full downloads (the first sync); the windows are small
      if (since == null) expected += r.count;
    }
  }

  // before touching the copy: from where the app's tables will be out of date
  for (const task of tasks) await markDirty(db, task.since == null ? "all" : toSeconds(task.since, task.t.unit));

  const progress = (table: string) => opts.onProgress?.({ rows: report.rows, expected: Math.max(expected, report.rows), table });

  /** downloads a device's rows of a table, from `since` (null: all), replacing the copy's ones */
  const download = async (t: TableMeta, device: number, since: number | null) => {
    const cols = t.columns;
    const insert = `INSERT OR REPLACE INTO ${q(t.name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    const blobIdx = t.blobs.map((b) => cols.indexOf(b));
    let after: string | undefined;
    let first = true;
    do {
      const page = await api.page(t.name, { device, since: since ?? undefined, after, limit: PAGE_SIZE });
      if (page.dataVersion !== server.dataVersion) throw new DataChanged();
      if (page.columns.join() !== cols.join()) throw new Error(`Colonne inattese in ${t.name}`);
      const rows = page.rows.map((r) => {
        const out = r as SqlParam[];
        for (const i of blobIdx) if (typeof out[i] === "string") out[i] = base64ToBytes(out[i] as string);
        return out;
      });
      // the first page also removes what it replaces, in the same transaction
      const before: Statement[] = first
        ? [{ sql: `DELETE FROM ${q(t.name)} WHERE DEVICE_ID = ?${since == null ? "" : ` AND ${q(t.time)} >= ?`}`, params: since == null ? [device] : [device, since] }]
        : [];
      if (db.bulk) await db.bulk(insert, rows, before);
      else await db.batch([...before, ...rows.map((params) => ({ sql: insert, params }))]);
      report.rows += rows.length;
      progress(t.name);
      first = false;
      after = page.next ?? undefined;
    } while (after);
  };

  for (const task of tasks) {
    const { t, device } = task;
    if (task.since == null) report.full.push(`${t.name}:${device}`);
    await download(t, device, task.since);
    const [{ n }] = await db.all<{ n: number }>(`SELECT count(*) AS n FROM ${q(t.name)} WHERE DEVICE_ID = ?`, [device]);
    if (n !== task.server.count) {
      // rows outside the window changed on the server: this device's table again, in full
      report.recounted.push(`${t.name}:${device}`);
      await markDirty(db, "all");
      await download(t, device, null);
    }
  }

  const devices = await api.devices();
  await db.batch([
    { sql: "DELETE FROM device_info" },
    ...devices.devices.map((d) => ({
      sql: `INSERT INTO device_info (${DEVICE_COLUMNS.join(", ")}) VALUES (${DEVICE_COLUMNS.map(() => "?").join(", ")})`,
      params: DEVICE_COLUMNS.map((c) => (d[c] ?? null) as SqlParam),
    })),
  ]);
  await setMeta(db, "last_sync_at", String(now()));
  if (server.dataTakenAt != null) await setMeta(db, "data_taken_at", String(server.dataTakenAt));
  report.ms = Date.now() - started;
  return report;
}
