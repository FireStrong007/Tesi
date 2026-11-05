import { describe, expect, it } from "vitest";
import { cumulative, energyFlow, estimateBmr, remaining, restingCalories, sampleRate, sleepDebt, stressAverage, stressLevelOf, stressMinutes } from "../src/lib/metrics";

const series = (vals: number[], step = 60, t0 = 1_700_000_000) => vals.map((value, i) => ({ timestamp: t0 + i * step, value }));

describe("stress like Gadgetbridge (Garmin ranges 1-25 / 26-50 / 51-75 / 76-100)", () => {
  it("assigns levels at the Garmin boundaries", () => {
    expect([1, 25, 26, 50, 51, 75, 76, 100].map((v) => stressLevelOf(v).key)).toEqual(["rest", "rest", "low", "low", "medium", "medium", "high", "high"]);
  });
  it("counts one sample interval per valid sample and ignores 0 / negative (not measured)", () => {
    const s = series([10, 0, 30, 60, 80, -1, -2, 20]);
    const m = stressMinutes(s);
    expect(m).toEqual({ rest: 2, low: 1, medium: 1, high: 1 });
    expect(stressAverage(s)).toBe((10 + 30 + 60 + 80 + 20) / 5);
  });
  it("uses the band's own sample rate", () => {
    const s = series([10, 10, 10, 90], 180);
    expect(sampleRate(s)).toBe(180);
    expect(stressMinutes(s)).toEqual({ rest: 9, low: 0, medium: 0, high: 3 });
  });
});

describe("other derived values", () => {
  it("Body Battery gained and lost", () => {
    expect(energyFlow(series([20, 25, 60, 55, 30, 31]))).toEqual({ charged: 41, drained: 30 });
  });
  it("cumulative totals for the day charts", () => {
    const rows = [{ timestamp: 100, steps: 0 }, { timestamp: 160, steps: 30 }, { timestamp: 220, steps: 12 }];
    expect(cumulative(rows, (r) => r.steps, 0)).toEqual([{ timestamp: 0, value: 0 }, { timestamp: 220, value: 30 }, { timestamp: 280, value: 42 }]);
  });
  it("resting calories are prorated to the time already passed (Gadgetbridge: 1404 of 1899 at 17:44)", () => {
    const day = Date.parse("2026-11-03T00:00:00+01:00") / 1000;
    const at = Date.parse("2026-11-03T17:44:00+01:00") / 1000;
    expect(restingCalories(1899, day, day + 86400, at)).toBe(1403);
    expect(restingCalories(1899, day, day + 86400, day + 2 * 86400)).toBe(1899);
    expect(restingCalories(null, day, day + 86400, at)).toBe(0);
  });
  it("estimates the metabolic rate from the profile when the band did not send it", () => {
    expect(estimateBmr({ weight_kg: 70, height_cm: 175, birthday: "1996-05-10", gender: "male" }, new Date("2026-11-03"))).toBe(1649); // 10·70 + 6,25·175 − 5·30 + 5
    expect(estimateBmr({ weight_kg: 70, height_cm: null, birthday: "1996-05-10", gender: "male" })).toBeNull();
  });
  it("sleep debt and missing steps", () => {
    expect(sleepDebt([480, 420, null, 0, 500], 480)).toBe(60);
    expect(remaining(8000, 7, 8415)).toBe(47585); // the week in the Gadgetbridge screenshot
    expect(remaining(8000, 1, 9000)).toBe(0);
  });
});
