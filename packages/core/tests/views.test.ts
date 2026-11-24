/**
 * The views that show the research server's Gadgetbridge tables with the app's schema, and the
 * comparison computed on the server's participants through them.
 */
import { describe, expect, it } from "vitest";
import { demoCohort } from "@bridge/synth/demo/cohort";
import { generateDemoFiles } from "@bridge/synth/demo/generator";
import { fitToServerRows, type Row } from "@bridge/synth/server/fit-to-server";
import { activitySamples, addDays, dailyTotals, startOfDay } from "../src/db/queries";
import { DEFAULT_STRIDE_CM } from "../src/metrics";
import { ActivityKind } from "../src/server/schema";
import { ServerComparisonSource, insertServerRows, participantsOf } from "../src/server/server-source";
import { createLocalViews } from "../src/server/views";
import { addParticipant, serverDb } from "./helpers";

const NOW = new Date("2026-11-08T21:00:00+01:00");
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

});

describe("distance for steps with no measured distance", () => {
  /** a day of cumulative rows: [minute of the day, steps counter, distance counter or -1] */
  async function person(db: ReturnType<typeof serverDb>, name: string, day: number, rows: [number, number, number][]) {
    const { pid, did } = await addParticipant(db, name);
    await insertServerRows(db, pid, did, {
      GARMIN_ACTIVITY_SAMPLE: rows.map(([m, steps, dist]) => ({ TIMESTAMP: day + m * 60, RAW_INTENSITY: 1, STEPS: steps, RAW_KIND: ActivityKind.ACTIVITY, HEART_RATE: 70, DISTANCE_CM: dist, ACTIVE_CALORIES: 0 })),
    });
    return pid;
  }

  it("estimates only steps that no later distance of the day covers: the person's step length, or 75 cm", async () => {
    const db = serverDb();
    const day = addDays(today, -2);
    // A: 200 minutes of 10 steps with distance measured every 4 minutes (80 cm per step), then 100
    // steps after the last measured distance
    const a: [number, number, number][] = [];
    for (let m = 1; m <= 200; m++) a.push([m, m * 10, m % 4 === 0 ? m * 10 * 80 : -1]);
    a.push([201, 2100, -1]);
    // B: steps, distance never measured
    const b: [number, number, number][] = [[1, 50, -1], [2, 120, -1]];
    const pa = await person(db, "a", day, a);
    const pb = await person(db, "b", day, b);
    await createLocalViews(db);
    const [ta] = await dailyTotals(db, pa, day, addDays(day, 1));
    // minutes without distance before a measured one are covered by its delta: no estimate there
    expect(ta.distance_m).toBeCloseTo((2000 * 80 + 100 * 80) / 100, 6);
    expect(ta.distance_estimated_m).toBeCloseTo(80, 6);
    const [tb] = await dailyTotals(db, pb, day, addDays(day, 1));
    expect(tb.distance_m).toBeCloseTo((120 * DEFAULT_STRIDE_CM) / 100, 6); // too few minutes: 75 cm
    expect(tb.distance_estimated_m).toBe(tb.distance_m);
    const samples = await activitySamples(db, pa, day, addDays(day, 1));
    expect(samples.reduce((s, r) => s + r.distance_est_cm, 0)).toBe(8000);
  });
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
