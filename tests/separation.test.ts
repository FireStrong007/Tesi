import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, it } from "vitest";
import { importFit } from "../src/lib/db/importer";
import { checkSchema, migrate } from "../src/lib/db/migrate";
import { addDays, addDevice, ensureDefaultUser, ensureDemoUser, listDevices, shareableUsers, startOfDay, storeFitFile } from "../src/lib/db/repo";
import { MIGRATIONS } from "../src/lib/db/schema";
import { oo1All, oo1Executor, type Oo1Db } from "../src/lib/db/sql";
import { generateDemoFiles } from "../src/lib/demo/generator";
import { storeFitInputs } from "../src/lib/gb-import";
import { loadRange } from "../src/lib/range-data";
import { memoryDb } from "./helpers";

const NOW = new Date("2026-11-08T20:00:00");
const today = startOfDay(Math.floor(NOW.getTime() / 1000));
const from = addDays(today, -6);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sqlite3 = await (sqlite3InitModule as any)({ print: () => {}, printErr: () => {} });
const emptyDb = () => new sqlite3.oo1.DB(":memory:") as Oo1Db;

/** A database built by the first `n` migrations only. */
function dbAtVersion(n: number) {
  const raw = emptyDb();
  for (let v = 0; v < n; v++) raw.exec({ sql: MIGRATIONS[v] });
  raw.exec({ sql: `PRAGMA user_version = ${n}` });
  return raw;
}

const dayMinutes = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

describe("demo data never adds up with a real band", () => {
  it("migration 6 moves an existing demo band, with all its rows, to a separate demo profile", async () => {
    // the situation found in a real database: one user with a real band and a demo band
    const raw = dbAtVersion(5);
    const db = oo1Executor(raw);
    await db.run("INSERT INTO user (name) VALUES ('Io')");
    await db.run("INSERT INTO device (user_id, name, is_demo) VALUES (1, 'vívosmart 5', 0), (1, 'vívosmart 5', 1)");
    for (const f of generateDemoFiles({ days: 7, seed: 4000, now: NOW })) await importFit(db, { deviceId: 1, userId: 1 }, f.data);
    for (const f of generateDemoFiles({ days: 7, seed: 7000, now: NOW })) await importFit(db, { deviceId: 2, userId: 1 }, f.data);
    const mixed = await loadRange(db, 1, from, today);
    // the bug: two series summed (steps doubled, more than 24 h of stress levels)
    expect(Math.max(...mixed.stressByLevel.map(dayMinutes))).toBeGreaterThan(1440);

    migrate(raw);
    const users = await db.all<{ id: number; name: string; is_demo: number }>("SELECT id, name, is_demo FROM user ORDER BY id");
    expect(users).toEqual([
      { id: 1, name: "Io", is_demo: 0 },
      { id: 2, name: "Demo", is_demo: 1 },
    ]);
    expect((await listDevices(db, 1)).map((d) => d.id)).toEqual([1]);
    expect((await listDevices(db, 2)).map((d) => d.id)).toEqual([2]);
    for (const t of ["activity_sample", "stress_sample", "body_energy_sample", "sleep_stage_sample", "hrv_summary_sample", "workout"])
      expect((await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE device_id = 2 AND user_id <> 2`))[0].n, t).toBe(0);

    // the real profile now shows exactly the real band's data
    const { db: alone } = await memoryDb();
    const u = await ensureDefaultUser(alone);
    const d = await addDevice(alone, { user_id: u.id, name: "x" });
    for (const f of generateDemoFiles({ days: 7, seed: 4000, now: NOW })) await importFit(alone, { deviceId: d.id, userId: u.id }, f.data);
    const expected = await loadRange(alone, u.id, from, today);
    const real = await loadRange(db, 1, from, today);
    expect(real.totals.map((t) => t.steps)).toEqual(expected.totals.map((t) => t.steps));
    expect(real.totals.map((t) => t.calories)).toEqual(expected.totals.map((t) => t.calories));
    expect(real.stressByLevel).toEqual(expected.stressByLevel);
    for (const m of real.stressByLevel) expect(dayMinutes(m)).toBeLessThanOrEqual(1440);
  });

  it("a demo band can only belong to the demo profile, a real one never", async () => {
    const { db } = await memoryDb();
    const me = await ensureDefaultUser(db);
    const demo = await ensureDemoUser(db);
    expect(demo.is_demo).toBe(1);
    expect(me.is_demo).toBe(0);
    await expect(addDevice(db, { user_id: me.id, name: "x", is_demo: true })).rejects.toThrow(/profilo Demo/);
    await expect(addDevice(db, { user_id: demo.id, name: "x" })).rejects.toThrow(/profilo Demo/);
    // files from Gadgetbridge never go into the demo profile
    const file = generateDemoFiles({ days: 1, seed: 1, now: NOW })[0];
    await expect(storeFitInputs(db, [{ name: "a.fit", mtime: 0, read: async () => file.data }], { userId: demo.id, fallbackDevice: "new" })).rejects.toThrow(/profilo Demo/);
  });

  it("the demo profile never contributes to comparisons or uploads", async () => {
    const { db } = await memoryDb();
    const me = await ensureDefaultUser(db);
    await ensureDemoUser(db);
    expect((await shareableUsers(db)).map((u) => u.id)).toEqual([me.id]);
  });

  it("the same file counts once: imported twice, or onto two bands of the same user", async () => {
    const { db } = await memoryDb();
    const me = await ensureDefaultUser(db);
    const a = await addDevice(db, { user_id: me.id, name: "a" });
    const b = await addDevice(db, { user_id: me.id, name: "b" });
    const files = generateDemoFiles({ days: 3, seed: 4000, now: NOW });
    const inputs = files.map((f, i) => ({ name: `${i}.fit`, mtime: f.date, read: async () => f.data }));
    const first = await storeFitInputs(db, inputs, { userId: me.id, fallbackDevice: a.id });
    expect(first.added).toBe(files.length);
    expect((await storeFitInputs(db, inputs, { userId: me.id, fallbackDevice: a.id })).duplicates).toBe(files.length);
    expect((await storeFitInputs(db, inputs, { userId: me.id, fallbackDevice: b.id })).duplicates).toBe(files.length);
    const entry = { fileIndex: 0, fileDataType: 128, fileSubType: 32, fileNumber: 1, specificFlags: 0, fileFlags: 0, fileSize: files[0].data.length, fileDate: files[0].date };
    expect((await storeFitFile(db, b.id, entry, files[0].data)).duplicate).toBe(true);
    expect((await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM fit_file"))[0].n).toBe(files.length);
  });
});

describe("startup schema check", () => {
  it("repairs a database that reached v5 without the v5 table and column", () => {
    // v1-v4 plus a different "v5": what the user's database looked like
    const raw = dbAtVersion(4);
    raw.exec({ sql: "PRAGMA user_version = 5" });
    migrate(raw); // v6 recreates workout_lap
    expect(oo1All(raw, "SELECT name FROM sqlite_master WHERE name = 'workout_lap'")).toHaveLength(1);
    const repairs = checkSchema(raw, emptyDb());
    expect(repairs).toEqual([{ message: "Colonna mancante «workout_record.temperature»: aggiunta", ok: true }]);
    expect(oo1All(raw, "PRAGMA table_info(workout_record)").map((c) => c.name)).toContain("temperature");
    // nothing left to repair, and a healthy database needs nothing
    expect(checkSchema(raw, emptyDb())).toEqual([]);
    const healthy = emptyDb();
    migrate(healthy);
    expect(checkSchema(healthy, emptyDb())).toEqual([]);
  });

  it("recreates a missing table with its indexes", () => {
    const raw = emptyDb();
    migrate(raw);
    raw.exec({ sql: "DROP TABLE live_sample" });
    const repairs = checkSchema(raw, emptyDb());
    expect(repairs.map((r) => r.message)).toEqual(["Tabella mancante «live_sample»: ricreata", "Indice mancante «live_user_ts»: ricreato"]);
    expect(repairs.every((r) => r.ok)).toBe(true);
  });
});

describe("valid days", () => {
  it("a day without the band worn is not valid (no data instead of 0)", async () => {
    const { db } = await memoryDb();
    const me = await ensureDefaultUser(db);
    const d = await addDevice(db, { user_id: me.id, name: "x" });
    for (const f of generateDemoFiles({ days: 3, seed: 4000, now: NOW })) await importFit(db, { deviceId: d.id, userId: me.id }, f.data);
    // a day with only a few hours of heart rate (band taken off in the morning)
    const off = addDays(today, -4);
    for (let t = off; t < off + 4 * 3600; t += 60)
      await db.run("INSERT INTO activity_sample (device_id, user_id, timestamp, activity_type, intensity, steps, heart_rate) VALUES (?,?,?,8,0,0,70)", [d.id, me.id, t]);
    const r = await loadRange(db, me.id, addDays(today, -5), today);
    expect(r.hrHours[0]).toBe(0);
    expect(r.hrHours[1]).toBe(4);
    expect(r.valid.slice(0, 2)).toEqual([false, false]);
    expect(r.valid.slice(3)).toEqual([true, true]);
  });
});
