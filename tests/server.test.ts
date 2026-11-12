import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, it } from "vitest";
import { userDailyValues } from "../src/lib/comparison/daily-values";
import { DemoComparisonSource, demoCohort } from "../src/lib/comparison/demo-source";
import { COMPARE_METRICS } from "../src/lib/comparison/types";
import { importFit } from "../src/lib/db/importer";
import { addDays, addDevice, ensureDefaultUser, startOfDay } from "../src/lib/db/repo";
import { oo1Executor, type Oo1Db, type SqlExecutor } from "../src/lib/db/sql";
import { generateDemoFiles } from "../src/lib/demo/generator";
import { loadRange } from "../src/lib/range-data";
import { fitToServerRows, type Row } from "../src/lib/server/fit-to-server";
import { ActivityKind, SERVER_SCHEMA } from "../src/lib/server/schema";
import { ServerComparisonSource, insertServerRows, participantsOf } from "../src/lib/server/server-source";
import { createLocalViews } from "../src/lib/server/views";
import { memoryDb } from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sqlite3 = await (sqlite3InitModule as any)({ print: () => {}, printErr: () => {} });

/** An empty server database with the professor's schema. */
function serverDb(): SqlExecutor {
  const raw = new sqlite3.oo1.DB(":memory:") as Oo1Db;
  raw.exec({ sql: SERVER_SCHEMA });
  return oo1Executor(raw);
}

/** Adds a participant with one band; returns their ids. */
async function addParticipant(db: SqlExecutor, name: string) {
  const p = await db.run("INSERT INTO participant (name, api_key_hash, created_at) VALUES (?, ?, 0)", [name, `hash-${name}`]);
  const pid = p.lastInsertRowid;
  const d = await db.run("INSERT INTO device (participant_id, identifier, name, manufacturer, type, type_name) VALUES (?, ?, 'vívosmart 5', 'Garmin', 0, 'GARMIN')", [pid, `serial-${name}`]);
  return { pid, did: d.lastInsertRowid };
}

const NOW = new Date("2026-11-08T21:00:00");
const nowTs = Math.floor(NOW.getTime() / 1000);
const today = startOfDay(nowTs);

describe("server views: the server's Gadgetbridge tables seen with the app's schema", () => {
  it("turns cumulative day counters into per-minute values", async () => {
    const db = serverDb();
    const { pid, did } = await addParticipant(db, "a");
    const day = addDays(today, -3);
    const row = (t: number, steps: number, hr = 70, kind: number = ActivityKind.ACTIVITY): Row => ({
      TIMESTAMP: t, RAW_INTENSITY: 1, STEPS: steps, RAW_KIND: kind, HEART_RATE: hr, DISTANCE_CM: steps * 70, ACTIVE_CALORIES: Math.floor(steps / 20),
    });
    await insertServerRows(db, pid, did, {
      GARMIN_ACTIVITY_SAMPLE: [
        row(day - 120, 9000), // 23:58 of the day before
        row(day, 9100), // midnight: closes the day before
        row(day + 60, 20), // counters restart after midnight
        row(day + 120, -1, -1), // gap row: not measured
        row(day + 180, 50),
        row(day + 240, -1, -1, ActivityKind.NOT_WORN), // not worn: left out
        row(day + 900, 30), // the counter went down (e.g. a new file): no value, new base
        row(day + 960, 45),
      ],
    });
    await createLocalViews(db);
    const rows = await db.all<{ timestamp: number; steps: number | null; heart_rate: number | null; distance_cm: number | null }>(
      "SELECT timestamp, steps, heart_rate, distance_cm FROM activity_sample ORDER BY timestamp",
    );
    expect(rows).toEqual([
      { timestamp: day - 180, steps: 9000, heart_rate: 70, distance_cm: 630000 }, // first of its day: the counter itself
      { timestamp: day - 60, steps: 100, heart_rate: 70, distance_cm: 7000 }, // midnight sample belongs to the day before
      { timestamp: day, steps: 20, heart_rate: 70, distance_cm: 1400 },
      { timestamp: day + 60, steps: null, heart_rate: null, distance_cm: null },
      { timestamp: day + 120, steps: 30, heart_rate: 70, distance_cm: 2100 },
      { timestamp: day + 840, steps: null, heart_rate: 70, distance_cm: null },
      { timestamp: day + 900, steps: 15, heart_rate: 70, distance_cm: 1050 },
    ]);
  });

  it("gives loadRange the same days as the app's own import of the same FIT files", async () => {
    const files = generateDemoFiles({ days: 10, seed: 4242, now: NOW });
    // the app: FIT files -> importer -> its tables
    const { db: app } = await memoryDb();
    const me = await ensureDefaultUser(app);
    const dev = await addDevice(app, { user_id: me.id, name: "x" });
    for (const f of files) await importFit(app, { deviceId: dev.id, userId: me.id }, f.data);
    // the server: FIT files -> Gadgetbridge format -> its tables -> views
    const server = serverDb();
    const { pid, did } = await addParticipant(server, "p1");
    const { rows, errors } = fitToServerRows(files.map((f) => f.data));
    expect(errors).toEqual([]);
    await insertServerRows(server, pid, did, rows);
    await createLocalViews(server);

    const from = addDays(today, -7);
    const a = await loadRange(app, me.id, from, today);
    const b = await loadRange(server, pid, from, today);
    expect(b.totals).toEqual(a.totals);
    expect(b.stressByLevel).toEqual(a.stressByLevel);
    expect(b.hrHours).toEqual(a.hrHours);
    expect(b.valid).toEqual(a.valid);
    expect(b.sleep.map((s) => s && { start: s.start, end: s.end, minutes: s.minutes })).toEqual(a.sleep.map((s) => s && { start: s.start, end: s.end, minutes: s.minutes }));
    for (const metric of COMPARE_METRICS) expect(userDailyValues(metric, b), metric).toEqual(userDailyValues(metric, a));
  }, 60_000);
});

describe("comparison on the server's participants", () => {
  /** n demo people, their FIT files converted and stored on the server, spread over `dbs` databases. */
  async function server(n: number, dbs: number) {
    const people = demoCohort(n);
    const databases = Array.from({ length: dbs }, serverDb);
    for (const [i, m] of people.entries()) {
      const db = databases[i % dbs];
      const { pid, did } = await addParticipant(db, m.id);
      const { rows } = fitToServerRows(generateDemoFiles({ days: 10, seed: m.seed, persona: m.persona, now: NOW }).map((f) => f.data));
      await insertServerRows(db, pid, did, rows);
    }
    return databases;
  }
  const from = addDays(today, -7);

  it("does not depend on how many databases hold the participants", async () => {
    const one = await ServerComparisonSource.open(await server(6, 1), () => nowTs);
    const three = await ServerComparisonSource.open(await server(6, 3), () => nowTs);
    for (const metric of ["steps", "sleep", "stress"] as const) {
      expect(await three.dailyDistribution(metric, from, today)).toEqual(await one.dailyDistribution(metric, from, today));
      expect(await three.periodStanding(metric, from, today, 8000)).toEqual(await one.periodStanding(metric, from, today, 8000));
    }
    const d = await one.dailyDistribution("steps", from, today);
    expect(d.every((x) => x.n === 6 && x.median != null)).toBe(true);
  }, 120_000);

  it("gives the same values as the demo cohort built from the same people", async () => {
    // same people, same days: the server path (FIT -> server tables -> views -> loadRange) and the
    // demo path (simulation -> day facts) must agree, as both follow the app's rules
    const src = await ServerComparisonSource.open(await server(5, 1), () => nowTs);
    const demo = new DemoComparisonSource({ size: 5, now: () => nowTs });
    for (const m of demo.members) Object.assign(m, { wear: 1, hasSpo2: true, hasHrv: true });
    for (const metric of ["steps", "calories", "sleep", "resting_hr", "stress", "body_battery", "respiration", "intensity"] as const) {
      const a = await src.dailyDistribution(metric, from, today);
      const b = await demo.dailyDistribution(metric, from, today);
      a.forEach((x, i) => {
        expect(x.n, metric).toBe(b[i].n);
        expect(x.median!, metric).toBeCloseTo(b[i].median!, 6);
      });
    }
  }, 120_000);

  it("leaves out the asking participant and needs 5 others", async () => {
    const dbs = await server(6, 2);
    const src = await ServerComparisonSource.open(dbs, () => nowTs);
    const all = await src.dailyDistribution("steps", from, today);
    const without = await src.dailyDistribution("steps", from, today, { excludeUserId: "demo-01" });
    expect(all[3].n).toBe(6);
    expect(without[3].n).toBe(5);
    const fewer = await src.dailyDistribution("steps", from, today, { excludeUserId: "demo-02" });
    expect(fewer[3].median).not.toBeNull();
    const small = await ServerComparisonSource.open(await server(5, 1), () => nowTs);
    const four = await small.dailyDistribution("steps", from, today, { excludeUserId: "demo-01" });
    expect(four.every((x) => x.n === 4 && x.median === null)).toBe(true);
  }, 120_000);

  it("refuses a participant present in two databases (counted twice)", async () => {
    const a = serverDb();
    const b = serverDb();
    await addParticipant(a, "same");
    await addParticipant(b, "same");
    await expect(participantsOf([a, b])).rejects.toThrow(/due database/);
  });
});
