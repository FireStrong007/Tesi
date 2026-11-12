/**
 * The value of each metric for one day, defined once and used both for the current user (from
 * loadRange) and for every member of a comparison cohort, so the two lines mean the same thing.
 */
import { addDays, startOfDay } from "../db/repo";
import { asleepMinutes, intensityScore, isValidDay } from "../metrics";
import type { RangeData } from "../range-data";
import type { CompareMetric } from "./types";

/** What is known about one person's day; null fields = no data. */
export interface DayFacts {
  /** distinct hours with a heart rate reading (how long the band was worn) */
  hrHours: number;
  /** steps counted by the band */
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

/**
 * The day's value of a metric, or null when that day has no valid data for it. Day totals (steps,
 * calories, intensity) need a valid day (band worn most of the day, metrics.isValidDay): otherwise
 * a day without the band would count as 0. Averaged metrics only need their own samples.
 */
export function metricValue(metric: CompareMetric, f: DayFacts | null): number | null {
  if (!f) return null;
  const worn = isValidDay(f.hrHours);
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
    hrHours: r.hrHours[i],
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

// ------------------------------------------------------------------ weeks and periods

/** Metrics compared as weekly totals (Monday–Sunday) instead of daily values. */
export const WEEKLY_METRICS: ReadonlySet<CompareMetric> = new Set<CompareMetric>(["intensity"]);

/** Local Monday 00:00 of the week containing day `d`. */
export function mondayOf(d: number): number {
  const day = startOfDay(d);
  return addDays(day, -((new Date(day * 1000).getDay() + 6) % 7));
}

/** Monday-aligned weeks covering [from, to): the range grown to whole weeks. */
export function weeksCovering(from: number, to: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let w = mondayOf(from); w < to; w = addDays(w, 7)) out.push({ start: w, end: addDays(w, 7) });
  return out;
}

/**
 * Weekly total of a day metric (e.g. intensity minutes): the sum over the week's valid days. It
 * counts only if at least half of the week's days so far are valid, otherwise null (band hardly
 * worn: a low total would say nothing). `values[i]` belongs to `days[i]`.
 */
export function weeklyTotal(days: number[], values: (number | null)[], week: { start: number; end: number }, now: number): number | null {
  let elapsed = 0;
  let valid = 0;
  let sum = 0;
  days.forEach((d, i) => {
    if (d < week.start || d >= week.end || d > now) return;
    elapsed++;
    const v = values[i];
    if (v != null) {
      valid++;
      sum += v;
    }
  });
  return elapsed > 0 && valid >= Math.ceil(elapsed / 2) ? sum : null;
}

/**
 * One person's value for a whole period, the unit of the comparison between people: the mean of
 * their valid days or, for weekly metrics, the mean of their complete weeks' totals. `days` counts
 * the valid days (the summary needs metrics.MIN_VALID_DAYS of them). Same rule for the user and for
 * every other user.
 */
export function periodValue(metric: CompareMetric, days: number[], values: (number | null)[], now: number): { value: number | null; days: number } {
  const validDays = values.filter((v) => v != null).length;
  let xs: number[];
  if (WEEKLY_METRICS.has(metric)) {
    const today = startOfDay(now);
    xs = weeksCovering(days[0], addDays(days[days.length - 1], 1))
      .filter((w) => w.end <= today)
      .map((w) => weeklyTotal(days, values, w, now))
      .filter((v): v is number => v != null);
  } else xs = values.filter((v): v is number => v != null);
  return { value: xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null, days: validDays };
}
