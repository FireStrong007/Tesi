/**
 * Hand-written FIT monitoring files (our encoder) and the rows Gadgetbridge's FitImporter stores
 * for them, written out by hand: an activity type that comes back after midnight, a gap longer
 * than 10 minutes (not worn), and the midnight row overwritten by the next file. The band runs on
 * Tokyo time (UTC+9), different from both this machine's and the CI's time zone, so the day
 * boundaries follow the band's clock and not the process's.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, it } from "vitest";
import { importFit } from "../src/lib/db/importer";
import { addDevice, ensureDefaultUser } from "../src/lib/db/repo";
import { oo1Executor, type Oo1Db } from "../src/lib/db/sql";
import { BaseType as B } from "../src/lib/fit/decoder";
import { FitEncoder, toGarminTs } from "../src/lib/fit/encoder";
import { fitToServerRows, type Row } from "../src/lib/server/fit-to-server";
import { SERVER_SCHEMA } from "../src/lib/server/schema";
import { insertServerRows } from "../src/lib/server/server-source";
import { createLocalViews } from "../src/lib/server/views";
import { STUDY_TIME_ZONE, processUsesZone, zoneTransitions } from "../src/lib/time-zone";
import { memoryDb } from "./helpers";

const OFFSET = 9 * 3600; // the band's clock: Asia/Tokyo, no daylight saving
/** band midnight starting 5 November 2026 (Tokyo), as unix seconds */
const M = Date.UTC(2026, 10, 5) / 1000 - OFFSET;
const H = 3600;
const MIN = 60;

type Counter = { type: number; cycles: number; distanceCm: number; calories: number };
interface Minute {
  t: number;
  hr?: number;
  /** current_activity_type_intensity: activity type and intensity */
  ati?: [number, number];
  moderate?: number;
  /** one monitoring record per activity type at this time */
  counters?: Counter[];
}

/** A MONITOR file as a vívosmart writes it: file_id, monitoring_info with the local time, monitoring records. */
function monitorFile(created: number, minutes: Minute[]) {
  const e = new FitEncoder();
  e.write(0, [
    { num: 0, base: B.ENUM, value: 32 },
    { num: 1, base: B.UINT16, value: 1 },
    { num: 2, base: B.UINT16, value: 3466 },
    { num: 3, base: B.UINT32Z, value: 3480000001 },
    { num: 4, base: B.UINT32, value: toGarminTs(created) },
    { num: 5, base: B.UINT16, value: 1 },
  ]);
  const start = minutes[0].t;
  e.write(103, [
    { num: 253, base: B.UINT32, value: toGarminTs(start) },
    { num: 0, base: B.UINT32, value: toGarminTs(start) + OFFSET }, // local_timestamp
  ]);
  let first = true;
  for (const m of minutes) {
    const time = first ? { num: 253, base: B.UINT32, value: toGarminTs(m.t) } : { num: 26, base: B.UINT16, value: toGarminTs(m.t) & 0xffff };
    first = false;
    const common = [
      ...(m.hr != null ? [{ num: 27, base: B.UINT8, value: m.hr }] : []),
      ...(m.ati ? [{ num: 24, base: B.BYTE, value: m.ati[0] | (m.ati[1] << 5) }] : []),
      ...(m.moderate ? [{ num: 33, base: B.UINT16, value: m.moderate }] : []),
    ];
    const counters = m.counters ?? [];
    if (!counters.length) e.write(55, [time, ...common]);
    counters.forEach((c, i) =>
      e.write(55, [
        // more records at the same time carry no time field (Gadgetbridge keeps the previous one)
        ...(i === 0 ? [time, ...common] : []),
        { num: 5, base: B.ENUM, value: c.type },
        { num: 3, base: B.UINT32, value: c.cycles }, // raw: steps (cycles x 2 with scale 2)
        { num: 2, base: B.UINT32, value: c.distanceCm },
        { num: 19, base: B.UINT16, value: c.calories },
      ]),
    );
  }
  return e.finish();
}

const walk = (cycles: number, distanceCm: number, calories: number): Counter => ({ type: 6, cycles, distanceCm, calories });
const generic = (calories: number): Counter => ({ type: 0, cycles: 0, distanceCm: 0, calories });

// evening of 4 November and the midnight totals
const fileA = monitorFile(M, [
  { t: M - 4 * H, hr: 80, ati: [6, 1], counters: [walk(200, 15000, 10), generic(7)] },
  { t: M - 4 * H + MIN, hr: 82, ati: [6, 1], counters: [walk(240, 17000, 11)] },
  { t: M - 3.5 * H, hr: 78, ati: [6, 1], moderate: 1, counters: [walk(300, 21000, 12)] }, // after 29 min without samples
  { t: M - 3.5 * H + 5 * MIN, hr: 75, ati: [6, 1], counters: [walk(320, 22000, 13)] }, // after 5 min
  { t: M, counters: [walk(400, 30000, 15), generic(7)] }, // the day's last totals, written at midnight
]);
// the next file starts at midnight with a sample without counters; "generic" comes back at 07:29
// band time, i.e. 23:29 in Rome and 22:29 UTC: still 4 November for a process in either zone, so
// only a reset at the band's midnight counts its 16 kcal in full
// (timestamp_16 covers at most ~9 hours between two samples)
const fileB = monitorFile(M + 10.5 * H, [
  { t: M, hr: 70 },
  { t: M + MIN, hr: 71, ati: [6, 1], counters: [walk(4, 300, 1)] },
  { t: M + 7 * H + 29 * MIN, hr: 90, ati: [0, 0], counters: [generic(16)] },
]);

/** a GARMIN_ACTIVITY_SAMPLE row as FitImporter stores it */
const row = (t: number, kind: number, intensity: number, steps: number, hr: number, distanceCm: number, calories: number): Row => ({
  TIMESTAMP: t, RAW_INTENSITY: intensity, STEPS: steps, RAW_KIND: kind, HEART_RATE: hr, DISTANCE_CM: distanceCm, ACTIVE_CALORIES: calories,
});
/** the rows FitImporter adds in a gap between two samples (prev, next): one per minute, all -1 */
const gap = (prev: number, next: number, kindIfShort: number) => {
  const out: Row[] = [];
  for (let t = prev + MIN; t < next; t += MIN) out.push(row(t, next - prev > 10 * MIN ? NOT_WORN : kindIfShort, -1, -1, -1, -1, -1));
  return out;
};
const ACTIVITY = 1;
const NOT_WORN = 8;

describe("server format of hand-written FIT files (Gadgetbridge's FitImporter rules)", () => {
  const { rows, errors } = fitToServerRows([fileA, fileB]);

  it("stores cumulative counters summed over activity types, gap rows, and lets the next file overwrite midnight", () => {
    expect(errors).toEqual([]);
    const t1 = M - 4 * H;
    const t2 = t1 + MIN;
    const t3 = M - 3.5 * H;
    const t4 = t3 + 5 * MIN;
    const b1 = M + MIN;
    const b2 = M + 7 * H + 29 * MIN;
    expect(rows.GARMIN_ACTIVITY_SAMPLE).toEqual([
      // steps = (walk + generic cycles) x 2 / 2 ... the raw value; calories summed over the types seen in the file
      row(t1, ACTIVITY, 1, 200, 80, 15000, 17),
      row(t2, ACTIVITY, 1, 240, 82, 17000, 18), // generic keeps its last value (7)
      ...gap(t2, t3, ACTIVITY), // 29 minutes: not worn
      row(t3, ACTIVITY, 1, 300, 78, 21000, 19),
      ...gap(t3, t4, ACTIVITY), // 5 minutes: same kind as before
      row(t4, ACTIVITY, 1, 320, 75, 22000, 20),
      ...gap(t4, M, ACTIVITY), // 3 h 25 min: not worn
      // file A wrote the midnight totals (400 steps, 30000 cm, 22 kcal) here; file B replaced the row
      // with its own first sample, which has no counters
      row(M, ACTIVITY, -1, -1, 70, -1, -1),
      row(b1, ACTIVITY, 1, 4, 71, 300, 1), // a new file starts with empty sums: only walking so far
      ...gap(b1, b2, ACTIVITY),
      row(b2, ACTIVITY, 0, 4, 90, 300, 17), // generic comes back: 1 + 16
    ]);
    expect(rows.GARMIN_INTENSITY_MINUTES_SAMPLE).toEqual([{ TIMESTAMP: t3 * 1000, MODERATE: 1, VIGOROUS: 0 }]);
  });

  it("the views give per-minute values per band day, with the midnight totals lost", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqlite3 = await (sqlite3InitModule as any)({ print: () => {}, printErr: () => {} });
    const raw = new sqlite3.oo1.DB(":memory:") as Oo1Db;
    raw.exec({ sql: SERVER_SCHEMA });
    const db = oo1Executor(raw);
    await db.run("INSERT INTO participant (id, name, api_key_hash, created_at) VALUES (1, 'p', 'h', 0)");
    await db.run("INSERT INTO device (id, participant_id, identifier, name, manufacturer, type, type_name) VALUES (1, 1, '3480000001', 'v', 'Garmin', 0, 'GARMIN')");
    await insertServerRows(db, 1, 1, rows);
    await createLocalViews(db, { timeZone: "Asia/Tokyo" });
    const sum = async (from: number, to: number) =>
      (await db.all<{ s: number; d: number; c: number }>(
        "SELECT SUM(steps) AS s, SUM(distance_cm) AS d, SUM(active_calories) AS c FROM activity_sample WHERE timestamp >= ? AND timestamp < ?",
        [from, to],
      ))[0];
    // 4 November: 200 + 40 + 60 + 20; the 80 steps of the midnight totals are gone
    expect(await sum(M - 24 * H, M)).toEqual({ s: 320, d: 22000, c: 20 });
    // 5 November: counted from zero at the band's midnight; generic's 16 kcal count in full
    expect(await sum(M, M + 24 * H)).toEqual({ s: 4, d: 300, c: 17 });
    // no row for the not-worn minutes, -1 shown as NULL
    const n = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM activity_sample");
    expect(n[0].n).toBe(4 + 4 + 1 + 2); // evening samples, short gap rows, the midnight row, the next day's samples
  });

  it("the app's importer restarts the counters at the band's midnight and keeps the midnight totals", async () => {
    const { db } = await memoryDb();
    const me = await ensureDefaultUser(db);
    const dev = await addDevice(db, { user_id: me.id, name: "x" });
    for (const f of [fileA, fileB]) await importFit(db, { deviceId: dev.id, userId: me.id }, f);
    const sum = async (from: number, to: number) =>
      (await db.all<{ s: number; d: number; c: number }>(
        "SELECT SUM(steps) AS s, SUM(distance_cm) AS d, SUM(active_calories) AS c FROM activity_sample WHERE timestamp >= ? AND timestamp < ?",
        [from, to],
      ))[0];
    expect(await sum(M - 24 * H, M)).toEqual({ s: 400, d: 30000, c: 22 });
    // with the counters carried over midnight, generic would count 16 - 7 = 9 kcal
    expect(await sum(M, M + 24 * H)).toEqual({ s: 4, d: 300, c: 17 });
  });
});

describe("time zone of the views", () => {
  it("knows daylight saving of the chosen zone", () => {
    const rome = zoneTransitions("Europe/Rome", 2026, 2027);
    expect(rome).toEqual([
      [Date.UTC(2026, 0, 1) / 1000, 3600],
      [Date.UTC(2026, 2, 29, 1) / 1000, 7200],
      [Date.UTC(2026, 9, 25, 1) / 1000, 3600],
    ]);
    expect(zoneTransitions("Asia/Tokyo", 2026, 2027)).toEqual([[Date.UTC(2026, 0, 1) / 1000, 9 * 3600]]);
  });

  it("the tests run, like the server must, in the study's time zone", () => {
    expect(STUDY_TIME_ZONE).toBe("Europe/Rome");
    expect(processUsesZone(STUDY_TIME_ZONE)).toBe(true);
    expect(processUsesZone("Asia/Tokyo")).toBe(false);
    expect(processUsesZone("Europe/London")).toBe(false);
  });
});
