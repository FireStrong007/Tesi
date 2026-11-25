/**
 * The browser's copy (core/sync) against the real server, in process: the copy has exactly the
 * participant's rows, the windows of the last 3 days are per table AND per device, a count that
 * does not match brings a full download of that device's table, and the app computes the same
 * days from the copy as from the server's database.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { createAppTables, updateAppTables } from "@bridge/core/adapters";
import { DATASETS } from "@bridge/core/datasets";
import { oo1Executor, type Oo1Db, type SqlExecutor } from "@bridge/core/db/sql";
import { loadRange } from "@bridge/core/range-data";
import { clearDirty, dirtyFrom, ownerOf, prepareLocalDb } from "@bridge/core/sync/local-db";
import { LOCAL_VIEWS } from "@bridge/core/server/views";
import { WINDOW_DAYS, syncCopy, type SyncApi } from "@bridge/core/sync/sync";
import { addDays, startOfDay } from "@bridge/core/time-zone";
import type { DataSource } from "../src/data-source";
import { executor } from "../src/sqlite";
import { NOW, participantClients, syntheticDb, tempDir, testServer, type Client } from "./helpers";

const dir = tempDir();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sqlite3 = await (sqlite3InitModule as any)({ print: () => {}, printErr: () => {} });

/** a server data source over a writable copy, so the test can change "the server's data" */
function writableSource(path: string) {
  const db = new DatabaseSync(path);
  let version = 1;
  const src: DataSource = {
    current: () => ({ db, file: path, version, takenAt: NOW.getTime() }),
    refresh: async () => ({ updated: false }),
    status: () => ({ mode: "file", takenAt: NOW.getTime(), version, lastAttemptAt: null, lastError: null, refreshing: false }),
    start: async () => {},
    close: () => db.close(),
  };
  return { db, src, changed: () => version++ };
}

function apiOf(c: Client): SyncApi {
  const get = async <T>(path: string) => {
    const r = await c.get<T>(path);
    if (r.status !== 200) throw new Error(`${path}: ${r.status} ${r.text}`);
    return r.body;
  };
  return {
    tables: () => get("/api/data/tables"),
    counts: () => get("/api/data/counts"),
    devices: () => get("/api/data/devices"),
    page: (t, p) => get(`/api/data/table/${t}?device=${p.device}&limit=${p.limit ?? 5000}${p.since != null ? `&since=${p.since}` : ""}${p.after ? `&after=${p.after}` : ""}`),
  };
}

function localDb(): SqlExecutor {
  return oo1Executor(new sqlite3.oo1.DB(":memory:") as Oo1Db);
}

const TABLES = DATASETS.vitabridge.dataTables;
/** every row of the participant, per table, in key order (the same columns as the copy) */
async function rowsOf(db: SqlExecutor, pid: number | null) {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t.name] = await db.all(`SELECT * FROM "${t.name}" ${pid == null ? "" : "WHERE USER_ID = ?"} ORDER BY DEVICE_ID, ${t.time}`, pid == null ? [] : [pid]);
  return out;
}

describe("the browser's copy of a participant's data", () => {
  let server: ReturnType<typeof writableSource>;
  let api: SyncApi;
  let pid: number;
  let otherApi: SyncApi;

  beforeAll(async () => {
    const path = join(dir, "server-copy.db");
    copyFileSync(syntheticDb("vitabridge", dir), path);
    server = writableSource(path);
    const s = await testServer({ dir, data: server.src });
    // SYN-G04 has two bands: the first one stopped some days before the second
    const { participants } = await participantClients(s, ["SYN-G04", "SYN-G01"]);
    api = apiOf(participants.get("SYN-G04")!.client);
    pid = participants.get("SYN-G04")!.participantId;
    otherApi = apiOf(participants.get("SYN-G01")!.client);
  });

  it("first sync: exactly the participant's rows of every table and device, and their devices", async () => {
    const local = localDb();
    expect(await prepareLocalDb(local, "vitabridge", ownerOf("vitabridge", "syn-g04"))).toBe(true);
    const report = await syncCopy(local, api);
    expect(report.rows).toBeGreaterThan(1000);
    expect(report.recounted).toEqual([]);
    expect(await rowsOf(local, null)).toEqual(await rowsOf(executor(server.db), pid));
    const devices = await local.all<{ id: number }>("SELECT id FROM device_info ORDER BY id");
    expect(devices.length).toBe(2);
    // the same days from the copy as from the server's database, through the same adapter
    await createAppTables(local, "vitabridge", { materialize: true });
    const serverSide = executor(new DatabaseSync(":memory:"));
    await serverSide.run(`ATTACH DATABASE '${server.db.location()!.replace(/'/g, "''")}' AS s`);
    for (const t of DATASETS.vitabridge.requiredTables) await serverSide.run(`CREATE TEMP VIEW "${t}" AS SELECT * FROM s."${t}"`);
    await createAppTables(serverSide, "vitabridge");
    const to = addDays(startOfDay(NOW.getTime() / 1000), 1);
    const from = addDays(to, -30);
    expect(await loadRange(local, pid, from, to)).toEqual(await loadRange(serverSide, pid, from, to));
    // another participant's copy has none of these rows
    const other = localDb();
    await prepareLocalDb(other, "vitabridge", ownerOf("vitabridge", "syn-g01"));
    await syncCopy(other, otherApi);
    const theirs = await other.all<{ u: number }>(`SELECT DISTINCT USER_ID AS u FROM GARMIN_ACTIVITY_SAMPLE`);
    expect(theirs.map((r) => r.u)).not.toContain(pid);
  });

  it("the last-3-days window is per device: a change on the older band is caught too", async () => {
    const local = localDb();
    await prepareLocalDb(local, "vitabridge", ownerOf("vitabridge", "syn-g04"));
    await syncCopy(local, api);
    const bands = server.db.prepare("SELECT DEVICE_ID AS d, max(TIMESTAMP) AS m FROM GARMIN_STRESS_SAMPLE WHERE USER_ID = ? GROUP BY DEVICE_ID ORDER BY m").all(pid) as { d: number; m: number }[];
    expect(bands.length).toBe(2);
    const [older, newer] = bands;
    // the older band's last days are outside the newer band's window
    expect(newer.m - older.m).toBeGreaterThan(WINDOW_DAYS * 86_400_000);
    const t = older.m - 86_400_000; // one day before its last sample
    const target = server.db.prepare("SELECT TIMESTAMP FROM GARMIN_STRESS_SAMPLE WHERE USER_ID = ? AND DEVICE_ID = ? AND TIMESTAMP <= ? ORDER BY TIMESTAMP DESC LIMIT 1").get(pid, older.d, t) as { TIMESTAMP: number };
    // replaced value (same count), a late row, a removed row: all within that band's window
    server.db.prepare("UPDATE GARMIN_STRESS_SAMPLE SET STRESS = 99 WHERE USER_ID = ? AND DEVICE_ID = ? AND TIMESTAMP = ?").run(pid, older.d, target.TIMESTAMP);
    server.db.prepare("INSERT INTO GARMIN_STRESS_SAMPLE (TIMESTAMP, DEVICE_ID, USER_ID, STRESS) VALUES (?, ?, ?, 42)").run(target.TIMESTAMP + 1, older.d, pid);
    const removed = server.db.prepare("SELECT TIMESTAMP FROM GARMIN_STRESS_SAMPLE WHERE USER_ID = ? AND DEVICE_ID = ? AND TIMESTAMP < ? ORDER BY TIMESTAMP DESC LIMIT 1").get(pid, older.d, target.TIMESTAMP) as { TIMESTAMP: number };
    server.db.prepare("DELETE FROM GARMIN_STRESS_SAMPLE WHERE USER_ID = ? AND DEVICE_ID = ? AND TIMESTAMP = ?").run(pid, older.d, removed.TIMESTAMP);
    server.changed();

    const report = await syncCopy(local, api);
    // caught by the window alone, no full download needed
    expect(report.recounted).toEqual([]);
    const value = await local.all<{ s: number }>("SELECT STRESS AS s FROM GARMIN_STRESS_SAMPLE WHERE DEVICE_ID = ? AND TIMESTAMP = ?", [older.d, target.TIMESTAMP]);
    expect(value).toEqual([{ s: 99 }]);
    expect((await local.all("SELECT 1 FROM GARMIN_STRESS_SAMPLE WHERE DEVICE_ID = ? AND TIMESTAMP = ?", [older.d, target.TIMESTAMP + 1])).length).toBe(1);
    expect((await local.all("SELECT 1 FROM GARMIN_STRESS_SAMPLE WHERE DEVICE_ID = ? AND TIMESTAMP = ?", [older.d, removed.TIMESTAMP])).length).toBe(0);
    expect(await rowsOf(local, null)).toEqual(await rowsOf(executor(server.db), pid));
  });

  it("a count that does not match (an old period recovered on the server) brings that device's table again, in full", async () => {
    const local = localDb();
    await prepareLocalDb(local, "vitabridge", ownerOf("vitabridge", "syn-g04"));
    await syncCopy(local, api);
    const band = (server.db.prepare("SELECT DEVICE_ID AS d, min(TIMESTAMP) AS m FROM GARMIN_ACTIVITY_SAMPLE WHERE USER_ID = ? GROUP BY DEVICE_ID ORDER BY m DESC LIMIT 1").get(pid) as { d: number; m: number });
    // a day recovered by hand, weeks before anything in the copy
    const old = band.m - 40 * 86_400;
    const ins = server.db.prepare("INSERT INTO GARMIN_ACTIVITY_SAMPLE (TIMESTAMP, DEVICE_ID, USER_ID, RAW_INTENSITY, STEPS, RAW_KIND, HEART_RATE, DISTANCE_CM, ACTIVE_CALORIES) VALUES (?, ?, ?, 1, ?, 1, 70, ?, ?)");
    for (let i = 0; i < 30; i++) ins.run(old + i * 60, band.d, pid, i * 10, i * 700, i);
    // and another table loses a device altogether on the server
    const gone = (server.db.prepare("SELECT DEVICE_ID AS d FROM GARMIN_BODY_ENERGY_SAMPLE WHERE USER_ID = ? GROUP BY DEVICE_ID ORDER BY DEVICE_ID LIMIT 1").get(pid) as { d: number }).d;
    server.db.prepare("DELETE FROM GARMIN_BODY_ENERGY_SAMPLE WHERE USER_ID = ? AND DEVICE_ID = ?").run(pid, gone);
    server.changed();

    const report = await syncCopy(local, api);
    expect(report.recounted).toEqual([`GARMIN_ACTIVITY_SAMPLE:${band.d}`]);
    expect(report.removed).toEqual([`GARMIN_BODY_ENERGY_SAMPLE:${gone}`]);
    expect((await local.all("SELECT 1 FROM GARMIN_ACTIVITY_SAMPLE WHERE DEVICE_ID = ? AND TIMESTAMP < ?", [band.d, band.m])).length).toBe(30);
    expect(await rowsOf(local, null)).toEqual(await rowsOf(executor(server.db), pid));
    // nothing changed since: the next sync only re-reads the windows
    const again = await syncCopy(local, api);
    expect(again.recounted).toEqual([]);
    expect(again.full).toEqual([]);
  });

  it("after a sync only the touched days of the app's tables are rebuilt, with the same result as a full rebuild", async () => {
    const local = localDb();
    await prepareLocalDb(local, "vitabridge", ownerOf("vitabridge", "syn-g04"));
    await syncCopy(local, api);
    expect(await dirtyFrom(local)).toBe("all"); // first download: everything
    expect(await updateAppTables(local, "vitabridge", { from: null })).toBe("full");
    await clearDirty(local);

    // the server changes in the last days: a late minute, a replaced stress value, a removed one
    const band = server.db.prepare("SELECT DEVICE_ID AS d, max(TIMESTAMP) AS m FROM GARMIN_ACTIVITY_SAMPLE WHERE USER_ID = ? GROUP BY DEVICE_ID ORDER BY m DESC LIMIT 1").get(pid) as { d: number; m: number };
    server.db
      .prepare("INSERT OR REPLACE INTO GARMIN_ACTIVITY_SAMPLE (TIMESTAMP, DEVICE_ID, USER_ID, RAW_INTENSITY, STEPS, RAW_KIND, HEART_RATE, DISTANCE_CM, ACTIVE_CALORIES) VALUES (?, ?, ?, 1, 999999, 1, 99, 999999, 999)")
      .run(band.m - 86_400 + 30, band.d, pid);
    const st = server.db.prepare("SELECT TIMESTAMP AS t FROM GARMIN_STRESS_SAMPLE WHERE USER_ID = ? AND DEVICE_ID = ? ORDER BY TIMESTAMP DESC LIMIT 2").all(pid, band.d) as { t: number }[];
    server.db.prepare("UPDATE GARMIN_STRESS_SAMPLE SET STRESS = 88 WHERE USER_ID = ? AND DEVICE_ID = ? AND TIMESTAMP = ?").run(pid, band.d, st[0].t);
    server.db.prepare("DELETE FROM GARMIN_STRESS_SAMPLE WHERE USER_ID = ? AND DEVICE_ID = ? AND TIMESTAMP = ?").run(pid, band.d, st[1].t);
    server.changed();

    await syncCopy(local, api);
    const dirty = await dirtyFrom(local);
    expect(typeof dirty).toBe("number"); // only the windows of the last days
    expect(await updateAppTables(local, "vitabridge", { from: startOfDay(dirty as number) })).toBe("partial");

    // the reference: a fresh copy, tables rebuilt in full
    const fresh = localDb();
    await prepareLocalDb(fresh, "vitabridge", ownerOf("vitabridge", "syn-g04"));
    await syncCopy(fresh, api);
    await updateAppTables(fresh, "vitabridge", { from: null });
    for (const v of LOCAL_VIEWS) {
      const all = async (db: SqlExecutor) => (await db.all(`SELECT * FROM main.${v.name}`)).map((r) => JSON.stringify(r)).sort();
      expect(await all(local), v.name).toEqual(await all(fresh));
    }
    const late = await local.all<{ s: number }>("SELECT steps AS s FROM activity_sample WHERE device_id = ? AND timestamp = ?", [band.d, band.m - 86_400 + 30 - 60]);
    expect(late.length).toBe(1);
  });

  it("a copy belongs to one person: another login must wipe it first", async () => {
    const local = localDb();
    expect(await prepareLocalDb(local, "vitabridge", ownerOf("vitabridge", "syn-g04"))).toBe(true);
    expect(await prepareLocalDb(local, "vitabridge", ownerOf("vitabridge", "syn-g04"))).toBe(true);
    expect(await prepareLocalDb(local, "vitabridge", ownerOf("vitabridge", "syn-g01"))).toBe(false);
    expect(await prepareLocalDb(local, "heartbridge", ownerOf("heartbridge", "syn-g04"))).toBe(false);
  });
});
