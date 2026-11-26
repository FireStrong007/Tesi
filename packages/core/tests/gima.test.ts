/**
 * The Gima adapter (gima/views.ts) on hand-written rows with the real data's shape: 30-minute step
 * blocks, heart rate every ~18 minutes, a night split in two segments, the invalid values the real
 * data have (filtered in one place), ECG recordings; and the same days whatever the update.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, it } from "vitest";
import { createAppTables, updateAppTables } from "../src/adapters";
import { oo1Executor, type Oo1Db, type SqlExecutor } from "../src/db/sql";
import { bloodPressureSamples, ecgBlob, ecgRecordings, sleepSessions, temperatureSamples } from "../src/db/queries";
import { loadDay } from "../src/day-data";
import { ECG_SAMPLE_RATE_HZ, decodeEcg, ecgAssessment } from "../src/gima/ecg";
import { GIMA_SCHEMA } from "../src/gima/schema";
import { loadRange } from "../src/range-data";
import { addDays, zonedTime } from "../src/time-zone";
import { factsFromRange } from "../src/comparison/daily-values";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sqlite3 = await (sqlite3InitModule as any)({ print: () => {}, printErr: () => {} });

const MIN = 60_000;
const day = zonedTime(2026, 11, 11); // Wednesday 11 November, midnight in Rome
const at = (h: number, m = 0, d = day) => (d + h * 3600 + m * 60) * 1000; // ms, like the server

function gimaDb(): SqlExecutor {
  const raw = new sqlite3.oo1.DB(":memory:") as Oo1Db;
  raw.exec({ sql: GIMA_SCHEMA });
  return oo1Executor(raw);
}

const ecgData = (samples: number[]) => {
  const b = new Uint8Array(samples.length * 4);
  const v = new DataView(b.buffer);
  samples.forEach((x, i) => v.setInt32(i * 4, x, true));
  return b;
};

async function fill(db: SqlExecutor) {
  await db.run("INSERT INTO participant (id, name, api_key_hash, created_at) VALUES (1, 'P1', 'h', 0)");
  await db.run("INSERT INTO device (id, participant_id, name, identifier) VALUES (1, 1, 'watch', 'x')");
  const ins = (table: string, cols: string[], rows: unknown[][]) =>
    db.batch(rows.map((r) => ({ sql: `INSERT INTO ${table} (${cols.join(", ")}, DEVICE_ID, USER_ID) VALUES (${cols.map(() => "?").join(", ")}, 1, 1)`, params: r as never[] })));
  // steps: three blocks on the 11th, one at 23:30 on the 10th (belongs to the 10th); the distance
  // in meters, like the real data (DISTANCE_CM holds meters)
  await ins("GIMA_ACTIVITY_SAMPLE", ["TIMESTAMP", "TIMESTAMP_END", "STEPS", "DISTANCE_CM", "ACTIVE_CALORIES"], [
    [at(-0.5), at(0), 500, 400, 20],
    [at(9), at(9.5), 1200, 960, 48],
    [at(9.5), at(10), 300, 240, 12],
    [at(18), at(18.5), 2000, 1600, 80],
  ]);
  // heart rate: every 20 minutes from 08:00 to 21:40 (14 hours), one 0 (not measured) at 22:10
  const hr = [];
  for (let t = at(8); t < at(22); t += 20 * MIN) hr.push([t, 70 + ((t / MIN) % 7)]);
  hr.push([at(22, 10), 0]);
  await ins("GIMA_HEART_RATE_SAMPLE", ["TIMESTAMP", "HEART_RATE"], hr);
  // blood pressure: one invalid (0), two valid
  await ins("GIMA_BLOOD_PRESSURE_SAMPLE", ["TIMESTAMP", "BP_SYSTOLIC", "BP_DIASTOLIC"], [[at(8), 118, 76], [at(12), 0, 0], [at(16), 122, 80]]);
  // body temperature: the real data's 0.15 °C, two valid, one out of range
  await ins("GIMA_BODY_TEMPERATURE_SAMPLE", ["TIMESTAMP", "TEMPERATURE"], [[at(8), 0.15], [at(9), 36.4], [at(10), 0.15], [at(11), 36.8], [at(12), 44.5]]);
  await ins("GIMA_SPO2_SAMPLE", ["TIMESTAMP", "SPO2"], [[at(8), 97], [at(9), 0], [at(10), 95]]);
  await ins("GIMA_RESPIRATORY_RATE_SAMPLE", ["TIMESTAMP", "RESPIRATORY_RATE"], [[at(8), 16], [at(9), 0], [at(10), 14]]);
  await ins("GIMA_HRV_VALUE_SAMPLE", ["TIMESTAMP", "HRV", "CVRR"], [[at(8), 30, 3], [at(9), 0, 0], [at(10), 40, 5]]);
  // a night split in two segments, like the real one: 23:30–06:00, awake 06:00–06:20, 06:20–07:30;
  // and an unknown stage code inside the first segment
  const stage = (h: number, m: number, d0: number, minutes: number, s: number) => [at(h, m, d0), minutes * 60, s];
  const prev = addDays(day, -1);
  await ins("GIMA_SLEEP_STAGE_SAMPLE", ["TIMESTAMP", "DURATION_SEC", "STAGE"], [
    stage(23, 30, prev, 90, 242), // light 23:30–01:00
    stage(1, 0, day, 60, 241), // deep 01:00–02:00
    stage(2, 0, day, 30, 250), // unknown 02:00–02:30
    stage(2, 30, day, 210, 242), // light 02:30–06:00
    stage(6, 20, day, 40, 241), // deep 06:20–07:00
    stage(7, 0, day, 30, 242), // light 07:00–07:30
  ]);
  await ins("GIMA_SLEEP_STATS_SAMPLE", ["TIMESTAMP", "TIMESTAMP_END", "RAPID_EYE_MOVEMENT_TOT", "DEEP_SLEEP_COUNT", "LIGHT_SLEEP_COUNT", "DEEP_SLEEP_TOT_MIN", "LIGHT_SLEEP_TOT_MIN"], [
    [at(23, 30, prev), at(6), 0, 1, 2, 60, 300],
    [at(6, 20), at(7, 30), 0, 1, 1, 40, 30],
  ]);
  // ECG: one with the device's values, one without (0) and ai_heart 400 (not a heart rate)
  const trace = Array.from({ length: 250 }, (_, i) => (i % 63 === 0 ? 480 : i % 7) - 3);
  await db.run(
    "INSERT INTO ECG_MEASUREMENTS (timestamp_string, start_measure_ms, duration_ms, sample_count, heart, dbp, sbp, hrv, is_afib, diagnose_type, ai_heart, DEVICE_ID, USER_ID, ecg_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)",
    ["2026-11-11 12:00:00", at(12), 68000, 250, 79, 76, 118, 41, 0, 1, 81, ecgData(trace)],
  );
  await db.run(
    "INSERT INTO ECG_MEASUREMENTS (timestamp_string, start_measure_ms, duration_ms, sample_count, heart, dbp, sbp, hrv, is_afib, diagnose_type, ai_heart, DEVICE_ID, USER_ID, ecg_data) VALUES (?, ?, 0, ?, 0, 0, 0, 0, 1, 5, 400, 1, 1, ?)",
    ["2026-11-11 15:00:00", at(15), 3, ecgData([1, -2, 500])],
  );
}

describe("Gima adapter", () => {
  it("steps in 30-minute blocks on their day, heart rate hours for the valid day, invalid values left out", async () => {
    const db = gimaDb();
    await fill(db);
    await createAppTables(db, "heartbridge");
    const r = await loadRange(db, 1, addDays(day, -1), addDays(day, 1));
    expect(r.totals.map((t) => t.steps)).toEqual([500, 3500]);
    expect(r.totals[1].calories).toBe(140);
    expect(r.totals[1].distance_m).toBe(2800); // meters, not centimeters
    // a block spread over its six 5-minute slots, the sum unchanged
    const d = await loadDay(db, 1, day);
    expect(d.samples.filter((x) => x.steps != null && x.timestamp >= at(9) / 1000 && x.timestamp < at(9.5) / 1000).map((x) => x.steps)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(d.steps).toBe(3500);
    expect(r.totals[1].distance_estimated_m).toBe(0); // always measured on Gima
    expect(r.hrHours[1]).toBe(14);
    expect(r.valid[1]).toBe(true);
    expect(r.hr[1].count).toBe(42); // the 0 left out
    expect(r.spo2[1]).toMatchObject({ count: 2, avg: 96 });
    expect(r.resp[1]).toMatchObject({ count: 2, avg: 15 });
    expect(r.hrvValues[1]).toMatchObject({ count: 2, avg: 35 });
    expect(r.cvrr[1]).toMatchObject({ count: 2, avg: 4 });
    expect(r.systolic[1]).toMatchObject({ count: 2, avg: 120, min: 118, max: 122 });
    expect(r.diastolic[1]).toMatchObject({ count: 2, avg: 78 });
    expect(r.temperature[1]).toMatchObject({ count: 2, min: 36.4, max: 36.8 });
    expect((await temperatureSamples(db, 1, day, addDays(day, 1))).map((x) => x.value)).toEqual([36.4, 36.8]);
    expect(await bloodPressureSamples(db, 1, day, addDays(day, 1))).toEqual([
      { timestamp: at(8) / 1000, systolic: 118, diastolic: 76 },
      { timestamp: at(16) / 1000, systolic: 122, diastolic: 80 },
    ]);
    // nothing of what the watch does not measure
    for (const k of ["stress", "energy", "resting"] as const) expect(r[k].every((x) => x.count === 0)).toBe(true);
    expect(r.hrv.every((x) => x == null)).toBe(true);
    // the comparison's HRV of a Gima day: the average of its values
    expect(factsFromRange(r, 1).hrvNightAvg).toBe(35);
  });

  it("a night in two segments is one night: the pause is awake, an unknown stage counts for nothing", async () => {
    const db = gimaDb();
    await fill(db);
    await createAppTables(db, "heartbridge");
    const [night] = await sleepSessions(db, 1, day, addDays(day, 1));
    expect(night).toMatchObject({ start: at(23, 30, addDays(day, -1)) / 1000, end: at(7, 30) / 1000, day });
    // light 90 + 210 + 30, deep 60 + 40 (the stats: 300 + 30 and 60 + 40), awake 20; the unknown 30 nowhere
    expect(night.minutes).toEqual({ light: 330, deep: 100, rem: 0, awake: 20 });
    expect(night.segments.map((s) => s.stage)).toEqual([2, 3, 2, 1, 3, 2]);
    expect(night.score).toBeNull();
    const d = await loadDay(db, 1, day);
    expect(d.sleepMinutes).toBe(430);
  });

  it("the day's SpO2 is 00:00–24:00 like the other day charts and like that day in Settimana / Mese", async () => {
    const db = gimaDb();
    await fill(db);
    // two measures the evening before (during the night that ends this day): not this day's
    const prev = addDays(day, -1);
    await db.batch([at(22, 0, prev), at(23, 45, prev)].map((t, i) => ({ sql: "INSERT INTO GIMA_SPO2_SAMPLE (TIMESTAMP, SPO2, DEVICE_ID, USER_ID) VALUES (?, ?, 1, 1)", params: [t, 90 + i] })));
    await createAppTables(db, "heartbridge");
    const d = await loadDay(db, 1, day);
    expect(d.spo2.map((p) => p.timestamp)).toEqual([at(8) / 1000, at(10) / 1000]);
    expect(d.spo2.every((p) => p.timestamp >= d.from && p.timestamp < d.to)).toBe(true);
    // the same measures as the day's bar of the month
    const r = await loadRange(db, 1, day, addDays(day, 1));
    expect(r.spo2[0]).toMatchObject({ count: d.spo2.length, avg: 96 });
    // the sleep chart keeps the night's measure of the evening before (the night is 23:30–07:30)
    expect(d.sleepSpo2.map((p) => p.value)).toEqual([91]);
  });

  it("the Home's SpO2 with a night: the average over the real sleep, like the one under the sleep chart", async () => {
    const db = gimaDb();
    await fill(db);
    // 22:00 the evening before (awake: not the night's), 23:45 and 03:00 (asleep)
    const rows = [[at(22, 0, addDays(day, -1)), 88], [at(23, 45, addDays(day, -1)), 91], [at(3), 93]];
    await db.batch(rows.map((r) => ({ sql: "INSERT INTO GIMA_SPO2_SAMPLE (TIMESTAMP, SPO2, DEVICE_ID, USER_ID) VALUES (?, ?, 1, 1)", params: r })));
    await createAppTables(db, "heartbridge");
    const d = await loadDay(db, 1, day);
    expect(d.spo2AvgOf).toBe("night");
    expect(d.spo2Avg).toBe(92);
    expect(d.spo2Avg).toBe(d.sleepSpo2.reduce((s, p) => s + p.value, 0) / d.sleepSpo2.length);
  });

  it("the Home's SpO2 with no sleep that night: the average of the day 00:00–24:00", async () => {
    const db = gimaDb();
    await fill(db);
    await db.run("DELETE FROM GIMA_SLEEP_STAGE_SAMPLE");
    await db.run("DELETE FROM GIMA_SLEEP_STATS_SAMPLE");
    // the evening before is not this day
    await db.run("INSERT INTO GIMA_SPO2_SAMPLE (TIMESTAMP, SPO2, DEVICE_ID, USER_ID) VALUES (?, 88, 1, 1)", [at(22, 0, addDays(day, -1))]);
    await createAppTables(db, "heartbridge");
    const d = await loadDay(db, 1, day);
    expect(d.sleep).toBeNull();
    expect(d.spo2AvgOf).toBe("day");
    expect(d.spo2Avg).toBe(96); // 97 at 08:00 and 95 at 10:00
  });

  it("ECG recordings: the device's values as they are, 0 and ai_heart above 300 as not given; the samples decoded", async () => {
    const db = gimaDb();
    await fill(db);
    await createAppTables(db, "heartbridge");
    const recs = await ecgRecordings(db, 1, day, addDays(day, 1));
    expect(recs.map((x) => x.timestamp)).toEqual([at(15) / 1000, at(12) / 1000]);
    expect(recs[1]).toMatchObject({ start_ms: at(12), duration_s: 68, sample_count: 250, heart: 79, sbp: 118, dbp: 76, hrv: 41, ai_heart: 81, diagnose_type: 1 });
    expect(recs[0]).toMatchObject({ duration_s: null, heart: null, sbp: null, dbp: null, hrv: null, ai_heart: null, is_afib: 1 });
    expect(Array.from(decodeEcg((await ecgBlob(db, 1, at(15)))!))).toEqual([1, -2, 500]);
    expect(await ecgBlob(db, 2, at(15))).toBeNull(); // another participant: nothing
    expect(ECG_SAMPLE_RATE_HZ).toBeCloseTo(83.333, 3);
    expect(ecgAssessment(recs[1].is_afib, recs[1].diagnose_type)).toBe("Ritmo normale");
    expect(ecgAssessment(1, 5)).toBe("Possibile fibrillazione atriale");
    expect(ecgAssessment(0, 5)).toBe("Possibili battiti prematuri ventricolari");
    expect(ecgAssessment(0, 9)).toBe("Possibili battiti prematuri atriali");
    expect(ecgAssessment(0, 42)).toBe("Non classificato");
  });

  it("the browser's copy: a partial update from a day gives the same tables as a full one", async () => {
    const db = gimaDb();
    await fill(db);
    expect(await updateAppTables(db, "heartbridge", { from: null })).toBe("full");
    const snapshot = async () => {
      const out: Record<string, string[]> = {};
      for (const t of ["activity_sample", "sleep_stage_sample", "sleep_session", "blood_pressure_sample", "body_temperature_sample", "hrv_value_sample", "ecg_recording"])
        out[t] = (await db.all(`SELECT * FROM main.${t}`)).map((x) => JSON.stringify(x)).sort();
      return out;
    };
    const full = await snapshot();
    expect(await updateAppTables(db, "heartbridge", { from: day })).toBe("partial");
    expect(await snapshot()).toEqual(full);
  });
});
