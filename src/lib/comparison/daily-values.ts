/**
 * The value of each metric for one day, defined once and used both for the current user (from
 * loadRange) and for every member of a comparison cohort, so the two lines mean the same thing.
 */
import { asleepMinutes, intensityScore } from "../metrics";
import type { RangeData } from "../range-data";
import type { CompareMetric } from "./types";

/** What is known about one person's day; null fields = no data. */
export interface DayFacts {
  /** steps counted by the band (0 = band not worn) */
  steps: number;
  activeCalories: number;
  moderateMinutes: number;
  vigorousMinutes: number;
  /** the night ending that morning */
  sleep: { light: number; deep: number; rem: number } | null;
  restingHr: number | null;
  /** average of the valid stress samples (>= 1) */
  stressAvg: number | null;
  bodyBatteryMax: number | null;
  spo2Avg: number | null;
  respirationAvg: number | null;
  hrvNightAvg: number | null;
}

/** The day's value of a metric, or null when that day has no valid data for it. */
export function metricValue(metric: CompareMetric, f: DayFacts | null): number | null {
  if (!f) return null;
  const worn = f.steps > 0;
  switch (metric) {
    case "steps":
      return worn ? f.steps : null;
    case "calories":
      return worn ? f.activeCalories : null;
    case "intensity":
      return worn ? intensityScore(f.moderateMinutes, f.vigorousMinutes) : null;
    case "sleep": {
      const m = f.sleep ? asleepMinutes(f.sleep) : 0;
      return m > 0 ? m : null;
    }
    case "resting_hr":
      return f.restingHr && f.restingHr > 0 ? f.restingHr : null;
    case "stress":
      return f.stressAvg;
    case "body_battery":
      return f.bodyBatteryMax;
    case "spo2":
      return f.spo2Avg && f.spo2Avg > 0 ? f.spo2Avg : null;
    case "respiration":
      return f.respirationAvg && f.respirationAvg > 0 ? f.respirationAvg : null;
    case "hrv":
      return f.hrvNightAvg && f.hrvNightAvg > 0 ? f.hrvNightAvg : null;
  }
}

/** The current user's facts for day i of a loaded range. */
export function factsFromRange(r: RangeData, i: number): DayFacts {
  const t = r.totals[i];
  const s = r.sleep[i];
  const has = (a: { count: number }) => a.count > 0;
  return {
    steps: t.steps,
    activeCalories: t.calories,
    moderateMinutes: r.intensity[i].moderate,
    vigorousMinutes: r.intensity[i].vigorous,
    sleep: s ? s.minutes : null,
    restingHr: has(r.resting[i]) ? r.resting[i].min : null,
    stressAvg: has(r.stress[i]) ? r.stress[i].avg : null,
    bodyBatteryMax: has(r.energy[i]) ? r.energy[i].max : null,
    spo2Avg: has(r.spo2[i]) ? r.spo2[i].avg : null,
    respirationAvg: has(r.resp[i]) ? r.resp[i].avg : null,
    hrvNightAvg: r.hrv[i]?.last_night_average ?? null,
  };
}

/** The current user's daily values of a metric over a loaded range (null = no data that day). */
export const userDailyValues = (metric: CompareMetric, r: RangeData) => r.days.map((_, i) => metricValue(metric, factsFromRange(r, i)));
