import { describe, expect, it } from "vitest";
import { averageOfUsers, MIN_USERS, summarizePeriod } from "../src/lib/comparison/aggregate";
import { metricValue, userDailyValues } from "../src/lib/comparison/daily-values";
import { DemoComparisonSource, demoCohort } from "../src/lib/comparison/demo-source";
import { COMPARE_METRICS } from "../src/lib/comparison/types";
import { importFit } from "../src/lib/db/importer";
import { addDays, addDevice, ensureDefaultUser, startOfDay } from "../src/lib/db/repo";
import { generateDemoFiles } from "../src/lib/demo/generator";
import { loadRange } from "../src/lib/range-data";
import { memoryDb } from "./helpers";

const NOW = new Date("2026-10-28T20:00:00");
const nowTs = Math.floor(NOW.getTime() / 1000);
const today = startOfDay(nowTs);

describe("daily average of the other users", () => {
  it("averages only the users with valid data", () => {
    expect(averageOfUsers([10, 20, null, 30, 40, 50, undefined])).toEqual({ mean: 30, n: 5 });
  });

  it("hides the average when fewer than 5 users contributed", () => {
    expect(MIN_USERS).toBe(5);
    expect(averageOfUsers([10, 20, 30, 40, null])).toEqual({ mean: null, n: 4 });
    expect(averageOfUsers([])).toEqual({ mean: null, n: 0 });
  });

  it("summarizes a period over the days where the user has data", () => {
    // others' day 2 is ignored: the user has no data that day
    expect(summarizePeriod([100, null, 200], [50, 1000, 150])).toEqual({ mine: 150, others: 100, diff: 0.5 });
    // no data at all: only the others' average
    expect(summarizePeriod([null, null], [100, 200])).toEqual({ mine: null, others: 150, diff: null });
  });
});

describe("demo comparison cohort", () => {
  const from = addDays(today, -9);

  it("excludes the current user from the average", async () => {
    const src = new DemoComparisonSource({ now: () => nowTs });
    const all = await src.dailyAverages("steps", from, today);
    const without = await src.dailyAverages("steps", from, today, { excludeUserId: "demo-03" });
    const me = src.members.find((m) => m.id === "demo-03")!;
    all.forEach((a, i) => {
      const mine = metricValue("steps", src.factsOf(me, a.day));
      if (mine == null) return expect(without[i]).toEqual(a);
      expect(without[i].n).toBe(a.n - 1);
      expect(without[i].mean!).toBeCloseTo((a.mean! * a.n - mine) / (a.n - 1), 6);
    });
  });

  it("hides the average with fewer than 5 people", async () => {
    const src = new DemoComparisonSource({ size: 4, now: () => nowTs });
    for (const a of await src.dailyAverages("steps", from, today)) {
      expect(a.n).toBeLessThanOrEqual(4);
      expect(a.mean).toBeNull();
    }
  });

  it("is deterministic and a day does not depend on the period asked", async () => {
    expect(demoCohort()).toEqual(demoCohort());
    const a = await new DemoComparisonSource({ now: () => nowTs }).dailyAverages("sleep", from, today);
    const b = await new DemoComparisonSource({ now: () => nowTs + 86400 * 40 }).dailyAverages("sleep", addDays(from, -20), today);
    expect(b.slice(20)).toEqual(a);
    // months back works too, with realistic and varied values
    const old = await new DemoComparisonSource().dailyAverages("steps", addDays(today, -200), addDays(today, -190));
    for (const d of old) {
      expect(d.n).toBeGreaterThanOrEqual(35);
      expect(d.mean!).toBeGreaterThan(3000);
      expect(d.mean!).toBeLessThan(16000);
    }
    const src = new DemoComparisonSource({ now: () => nowTs });
    const steps = src.members.map((m) => metricValue("steps", src.factsOf(m, addDays(today, -3)))).filter((v): v is number => v != null);
    expect(Math.max(...steps) / Math.min(...steps)).toBeGreaterThan(2);
  });

  it("future days have no data", async () => {
    const src = new DemoComparisonSource({ now: () => nowTs });
    const [d] = await src.dailyAverages("steps", addDays(today, 1), addDays(today, 2));
    expect(d).toEqual({ day: addDays(today, 1), mean: null, n: 0 });
  });

  it("computes each person's day with the same rules as loadRange", async () => {
    const src = new DemoComparisonSource({ now: () => nowTs });
    for (const member of src.members.slice(0, 2)) {
      const m = { ...member, wear: 1, hasSpo2: true, hasHrv: true };
      const { db } = await memoryDb();
      const user = await ensureDefaultUser(db);
      const dev = await addDevice(db, { user_id: user.id, name: "vívosmart 5" });
      // 20 days imported, the last 10 compared: the band's counters and the midnight samples of
      // the earlier days are then the same in the database and in the cohort
      for (const f of generateDemoFiles({ days: 20, seed: m.seed, persona: m.persona, now: NOW })) await importFit(db, { deviceId: dev.id, userId: user.id }, f.data);
      const rFrom = addDays(today, -9);
      const r = await loadRange(db, user.id, rFrom, addDays(today, 1));
      for (const metric of COMPARE_METRICS) {
        const mine = userDailyValues(metric, r);
        r.days.forEach((d, i) => {
          const theirs = metricValue(metric, src.factsOf(m, d));
          if (mine[i] == null || theirs == null) expect({ metric, d, v: theirs }).toEqual({ metric, d, v: mine[i] });
          else expect(theirs, `${metric} ${new Date(d * 1000).toDateString()}`).toBeCloseTo(mine[i]!, 6);
        });
      }
    }
  });
});

describe("loadRange stress average", () => {
  it("ignores samples that are not measurements (< 1)", async () => {
    const { db } = await memoryDb();
    const user = await ensureDefaultUser(db);
    const dev = await addDevice(db, { user_id: user.id, name: "x" });
    for (const [t, v] of [[today + 3600, 0], [today + 7200, 40], [today + 10800, 60]])
      await db.run("INSERT INTO stress_sample VALUES (?,?,?,?)", [dev.id, user.id, t, v]);
    const r = await loadRange(db, user.id, today, addDays(today, 1));
    expect(r.stress[0].avg).toBe(50);
    expect(r.stress[0].min).toBe(40);
  });
});
