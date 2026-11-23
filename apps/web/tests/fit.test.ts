import { describe, expect, it } from "vitest";
import { importFit } from "../src/lib/db/importer";
import { addDevice, dailyTotals, ensureDemoUser, sleepSessions, startOfDay, addDays, workoutRecords, listWorkouts } from "../src/lib/db/repo";
import { generateDemoFiles } from "../src/lib/demo/generator";
import { BaseType as B, decodeFit } from "../src/lib/fit/decoder";
import { FitEncoder, toGarminTs } from "../src/lib/fit/encoder";
import { memoryDb } from "./helpers";

describe("FIT decoder", () => {
  it("decodes encoded records with scale, DateTime and invalid values", () => {
    const e = new FitEncoder();
    const t = 1_700_000_000;
    e.write(0, [{ num: 0, base: B.ENUM, value: 32 }, { num: 4, base: B.UINT32, value: toGarminTs(t) }]);
    e.write(227, [
      { num: 0, base: B.SINT16, value: 42 },
      { num: 1, base: B.UINT32, value: toGarminTs(t + 180) },
      { num: 3, base: B.SINT8, value: 77 },
    ]);
    e.write(297, [{ num: 253, base: B.UINT32, value: toGarminTs(t) }, { num: 0, base: B.SINT16, value: 1550 }]);
    e.write(55, [{ num: 253, base: B.UINT32, value: toGarminTs(t) }, { num: 27, base: B.UINT8, value: null }]);
    const fit = decodeFit(e.finish());
    expect(fit.crcOk).toBe(true);
    expect(fit.records.map((r) => r.name)).toEqual(["file_id", "stress_level", "respiration_rate", "monitoring"]);
    expect(fit.records[0].fields.time_created).toBe(t);
    expect(fit.records[1].fields.stress_level_time).toBe(t + 180);
    expect(fit.records[1].fields.body_energy).toBe(77);
    expect(fit.records[2].fields.respiration_rate).toBeCloseTo(15.5);
    expect(fit.records[2].timestamp).toBe(t);
    expect(fit.records[3].fields.heart_rate).toBeNull();
  });

  it("handles compressed timestamp headers", () => {
    // hand-built: definition for local 0 = record(20) with heart_rate, then a full ts record and two compressed
    const t0 = toGarminTs(1_700_000_000);
    const body = [
      0x40, 0, 0, 20, 0, 2, 253, 4, 0x86, 3, 1, 0x02, // def local 0: timestamp + hr
      0x00, t0 & 0xff, (t0 >> 8) & 0xff, (t0 >> 16) & 0xff, (t0 >>> 24) & 0xff, 100,
      0x41, 0, 0, 20, 0, 1, 3, 1, 0x02, // def local 1: hr only
      0x80 | (1 << 5) | ((t0 + 3) & 0x1f), 101,
      0x80 | (1 << 5) | ((t0 + 20) & 0x1f), 102,
    ];
    const header = [12, 0x10, 0x54, 0x08, body.length, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54];
    const fit = decodeFit(Uint8Array.from([...header, ...body, 0, 0]));
    expect(fit.records.map((r) => r.timestamp! - 1_700_000_000)).toEqual([0, 3, 20]);
  });
});

describe("FIT import", () => {
  it("imports a generated week into SQLite with sane daily values", async () => {
    const { db } = await memoryDb();
    const user = await ensureDemoUser(db);
    const dev = await addDevice(db, { user_id: user.id, name: "vívosmart 5", is_demo: true });
    const now = new Date("2026-10-28T21:30:00");
    const files = generateDemoFiles({ days: 7, seed: 7, now });
    for (const f of files) await importFit(db, { deviceId: dev.id, userId: user.id }, f.data);

    const today = startOfDay(now.getTime() / 1000);
    const days = await dailyTotals(db, user.id, addDays(today, -6), addDays(today, 1));
    expect(days).toHaveLength(7);
    for (const d of days) {
      expect(d.steps).toBeGreaterThan(2000);
      expect(d.steps).toBeLessThan(40000);
    }

    // re-importing the same files must not double count
    const before = days.reduce((s, d) => s + d.steps, 0);
    for (const f of files) await importFit(db, { deviceId: dev.id, userId: user.id }, f.data);
    const again = (await dailyTotals(db, user.id, addDays(today, -6), addDays(today, 1))).reduce((s, d) => s + d.steps, 0);
    expect(again).toBe(before);

    const sleeps = await sleepSessions(db, user.id, addDays(today, -6), addDays(today, 1));
    expect(sleeps.length).toBeGreaterThanOrEqual(6);
    for (const s of sleeps) {
      const total = s.minutes.light + s.minutes.deep + s.minutes.rem;
      expect(total).toBeGreaterThan(300);
      expect(s.score).not.toBeNull();
    }

    const workouts = await listWorkouts(db, user.id);
    expect(workouts.length).toBeGreaterThan(0);
    const recs = await workoutRecords(db, workouts[0].id);
    expect(recs.length).toBeGreaterThan(100);
    expect(recs[0].lat!).toBeCloseTo(45.47, 1);
  });
});
