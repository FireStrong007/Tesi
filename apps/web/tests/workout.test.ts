import { describe, expect, it } from "vitest";
import { importFit } from "../src/lib/db/importer";
import { addDevice, ensureDefaultUser, listWorkouts, workoutLaps, workoutRecords } from "../src/lib/db/repo";
import { generateDemoFiles } from "../src/lib/demo/generator";
import { distanceSplits, hrZones, paceLabel, parseSummary, smooth, workoutCadence, workoutSteps, zoneThresholds } from "../src/lib/workout";
import { memoryDb } from "./helpers";

describe("activity import", () => {
  it("stores laps, temperature, cadence and the heart-rate zones of a run", async () => {
    const { db } = await memoryDb();
    const user = await ensureDefaultUser(db);
    const dev = await addDevice(db, { user_id: user.id, name: "vívosmart 5" });
    const files = generateDemoFiles({ days: 7, seed: 5, now: new Date("2026-10-28T23:00:00") });
    for (const f of files) await importFit(db, { deviceId: dev.id, userId: user.id }, f.data);

    const run = (await listWorkouts(db, user.id)).find((w) => w.sport === 1);
    expect(run).toBeDefined();
    const laps = await workoutLaps(db, run!.id);
    // auto-lap every km: all laps but the last are 1 km
    expect(laps.length).toBeGreaterThan(3);
    for (const l of laps.slice(0, -1)) expect(l.distance_m!).toBeGreaterThanOrEqual(1000);
    expect(laps.reduce((s, l) => s + l.distance_m!, 0)).toBeCloseTo(run!.distance_m!, -1);

    const recs = await workoutRecords(db, run!.id);
    expect(recs.every((r) => r.temperature !== null)).toBe(true);
    expect(workoutCadence(run!.sport, recs[recs.length - 1].cadence)!).toBeGreaterThan(150);
    expect(workoutSteps(run!)!).toBeGreaterThan(2000);

    const s = parseSummary(run!);
    expect(zoneThresholds(s, null)).toEqual([112, 130, 149, 167]);
    expect(s.total_training_effect).toBeGreaterThan(2);

    // re-importing replaces the laps instead of duplicating them
    for (const f of files) await importFit(db, { deviceId: dev.id, userId: user.id }, f.data);
    const again = (await listWorkouts(db, user.id)).find((w) => w.sport === 1)!;
    expect((await workoutLaps(db, again.id)).length).toBe(laps.length);
  });
});

describe("activity helpers", () => {
  it("splits a track every km, interpolating the crossing time", () => {
    // 2.5 m/s for 2500 m, one point every 10 s
    const recs = Array.from({ length: 101 }, (_, i) => ({ timestamp: 1000 + i * 10, distance: i * 25, heart_rate: 140 }));
    const splits = distanceSplits(recs);
    expect(splits.map((s) => Math.round(s.seconds))).toEqual([400, 400, 200]);
    expect(splits[2].distance_m).toBe(500);
    expect(paceLabel(splits[0].speed)).toBe("6:40");
    expect(splits[0].avg_hr).toBe(140);
  });

  it("measures time in zones", () => {
    const recs = [100, 120, 135, 150, 170, 170].map((hr, i) => ({ timestamp: i * 10, heart_rate: hr }));
    const z = hrZones(recs, [112, 130, 149, 167]);
    expect(z.map((x) => x.seconds)).toEqual([10, 10, 10, 10, 11]);
    expect(z[0].lo).toBeNull();
    expect(z[4].hi).toBeNull();
  });

  it("falls back to % of the max heart rate and smooths series", () => {
    expect(zoneThresholds({}, 200)).toEqual([120, 140, 160, 180]);
    expect(zoneThresholds({}, null)).toBeNull();
    const pts = [1, 3, 1, 3].map((v, i) => ({ timestamp: i, value: v }));
    expect(smooth(pts, 2).map((p) => p.value)).toEqual([2, 5 / 3, 7 / 3, 2]);
  });
});
