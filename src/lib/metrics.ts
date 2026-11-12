/**
 * Derived values shown in the metric pages, with the same definitions Gadgetbridge uses.
 * Pure functions (no database, no UI) so they can be unit tested.
 */
import type { TimeValue } from "./db/repo";

// ------------------------------------------------------------------ stress

/**
 * Stress levels with Gadgetbridge's ranges for Garmin watches/bands (GarminWatchCoordinator.getStressRanges):
 * 1-25 relaxed, 26-50 low, 51-75 moderate, 76-100 high. 0 or negative = not measured.
 */
export const STRESS_LEVELS = [
  { key: "rest", label: "Rilassato", max: 25, color: "var(--stress-rest)" },
  { key: "low", label: "Leggero", max: 50, color: "var(--stress-low)" },
  { key: "medium", label: "Moderato", max: 75, color: "var(--stress-medium)" },
  { key: "high", label: "Elevato", max: 100, color: "var(--stress-high)" },
] as const;
/** values below this are "not measured" (Gadgetbridge: StressType.UNKNOWN) */
export const STRESS_MIN_VALID = 1;
export type StressKey = (typeof STRESS_LEVELS)[number]["key"];

export const stressLevelOf = (v: number) => STRESS_LEVELS.find((l) => v <= l.max) ?? STRESS_LEVELS[3];

/** Most common spacing between samples, in seconds (the band's sample rate: 60 s on a vívosmart 5). */
export function sampleRate(samples: { timestamp: number }[], fallback = 60): number {
  const counts = new Map<number, number>();
  for (let i = 1; i < samples.length; i++) {
    const g = samples[i].timestamp - samples[i - 1].timestamp;
    if (g > 0 && g <= 900) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best = fallback;
  let n = 0;
  for (const [g, c] of counts) if (c > n) (best = g), (n = c);
  return best;
}

/**
 * Minutes spent in each stress level. Like Gadgetbridge every valid sample counts as one sample
 * interval (gaps without data are not filled).
 */
export function stressMinutes(samples: TimeValue[]): Record<StressKey, number> {
  const out: Record<StressKey, number> = { rest: 0, low: 0, medium: 0, high: 0 };
  const rate = sampleRate(samples) / 60;
  for (const s of samples) if (s.value >= STRESS_MIN_VALID) out[stressLevelOf(s.value).key] += rate;
  return out;
}

/** Average of the valid stress samples. */
export const stressAverage = (samples: TimeValue[]) => {
  const v = samples.filter((s) => s.value >= STRESS_MIN_VALID);
  return v.length ? v.reduce((a, s) => a + s.value, 0) / v.length : null;
};

// ------------------------------------------------------------------ Body Battery

/** Points gained and lost over the series (Gadgetbridge: "Acquisita" / "Persa"). */
export function energyFlow(e: TimeValue[]): { charged: number; drained: number } {
  let charged = 0;
  let drained = 0;
  for (let i = 1; i < e.length; i++) {
    const diff = e[i].value - e[i - 1].value;
    if (diff > 0) charged += diff;
    else drained -= diff;
  }
  return { charged, drained };
}

// ------------------------------------------------------------------ cumulative series

/** Running total of a per-sample value, as a time series (cumulative steps / calories during the day). */
export function cumulative<T extends { timestamp: number }>(rows: T[], value: (r: T) => number, from: number): TimeValue[] {
  const out: TimeValue[] = [{ timestamp: from, value: 0 }];
  let sum = 0;
  for (const r of rows) {
    const v = value(r);
    if (!v) continue;
    sum += v;
    out.push({ timestamp: r.timestamp + 60, value: sum });
  }
  return out;
}

// ------------------------------------------------------------------ calories

export interface ProfileForBmr {
  weight_kg: number | null;
  height_cm: number | null;
  birthday: string | null;
  gender: string | null;
}

/** Mifflin-St Jeor estimate, used only when the band did not report its resting metabolic rate. */
export function estimateBmr(p: ProfileForBmr, at = new Date()): number | null {
  if (!p.weight_kg || !p.height_cm || !p.birthday) return null;
  const b = new Date(p.birthday);
  if (Number.isNaN(b.getTime())) return null;
  let age = at.getFullYear() - b.getFullYear();
  if (at.getMonth() < b.getMonth() || (at.getMonth() === b.getMonth() && at.getDate() < b.getDate())) age--;
  const base = 10 * p.weight_kg + 6.25 * p.height_cm - 5 * age;
  const sex = p.gender === "male" ? 5 : p.gender === "female" ? -161 : -78;
  return Math.round(base + sex);
}

/**
 * Resting calories burned in a day: the metabolic rate prorated to the part of the day already
 * passed (Gadgetbridge shows 1404 "a riposo" at 17:45 with a rate of 1899 kcal/day).
 */
export function restingCalories(bmrPerDay: number | null, dayStart: number, dayEnd: number, now = Date.now() / 1000): number {
  if (!bmrPerDay) return 0;
  const elapsed = Math.max(0, Math.min(now, dayEnd) - dayStart);
  return Math.round((bmrPerDay * elapsed) / (dayEnd - dayStart));
}

// ------------------------------------------------------------------ valid day

/**
 * A day counts in averages and comparisons only if the band was worn for most of it: heart rate
 * recorded in at least this many distinct hours. A day without the band (or with only a few
 * hours) is "no data", not 0. This is the only definition, used for the user's own data
 * (loadRange) and for the comparison cohort alike.
 */
export const VALID_DAY_MIN_HR_HOURS = 10;
export const isValidDay = (hoursWithHeartRate: number) => hoursWithHeartRate >= VALID_DAY_MIN_HR_HOURS;

/** The summary judgement against other users needs at least this many valid days in the period. */
export const MIN_VALID_DAYS = 7;

// ------------------------------------------------------------------ intensity minutes

/** Garmin/WHO intensity minutes: vigorous minutes count double. */
export const intensityScore = (moderate: number, vigorous: number) => moderate + 2 * vigorous;

// ------------------------------------------------------------------ sleep

/** Minutes actually asleep in a night (awake time excluded). */
export const asleepMinutes = (m: { light: number; deep: number; rem: number }) => m.light + m.deep + m.rem;

/** Sleep debt over the nights with data: sum of (goal - slept) where slept < goal. */
export function sleepDebt(nightsMinutes: (number | null)[], goalMin: number): number {
  return nightsMinutes.reduce<number>((s, m) => (m != null && m > 0 && m < goalMin ? s + (goalMin - m) : s), 0);
}

export interface SeriesStats {
  min: number | null;
  max: number | null;
  avg: number | null;
}
export function stats(values: number[]): SeriesStats {
  if (!values.length) return { min: null, max: null, avg: null };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, avg: sum / values.length };
}

/** Points of a series inside [start, end). */
export const within = (s: TimeValue[], start: number, end: number) => s.filter((p) => p.timestamp >= start && p.timestamp < end);

/** Total minus what was already reached, never negative (Gadgetbridge: "Passi mancanti", "Sotto l'obiettivo"). */
export const remaining = (goalPerDay: number, days: number, total: number) => Math.max(0, goalPerDay * days - total);
