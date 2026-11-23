/**
 * Derived values for the activity screens: heart-rate zones, km splits, cadence in steps/min,
 * smoothed pace. Pure functions (no UI), tested in tests/workout.test.ts.
 */
import type { TimeValue, User, Workout, WorkoutRecord } from "./db/repo";

/** sports whose FIT cadence is in strides/min and cycles are strides (running, walking, hiking) */
export const isFootSport = (sport: number | null) => sport === 1 || sport === 11 || sport === 17;

/** pace (min/km) reads better than speed for these */
export const usesPace = (sport: number | null) => isFootSport(sport) || sport === 5;

/** Garmin writes running/walking cadence in strides per minute: one stride = two steps */
export const workoutCadence = (sport: number | null, v: number | null | undefined) => (v == null ? null : isFootSport(sport) ? v * 2 : v);
export const cadenceUnit = (sport: number | null) => (isFootSport(sport) ? "passi/min" : "rpm");

export const workoutSteps = (w: Pick<Workout, "sport" | "steps">) => (w.steps == null || !isFootSport(w.sport) ? null : w.steps * 2);

/** the session fields saved at import (all FIT "session" fields + _zones) */
export interface WorkoutSummary {
  [k: string]: unknown;
  _zones?: { bounds: number[] | null; times: number[] | null; max_hr: number | null; resting_hr: number | null };
}

export function parseSummary(w: Pick<Workout, "summary">): WorkoutSummary {
  try {
    return JSON.parse(w.summary || "{}");
  } catch {
    return {};
  }
}

/** a numeric session field, or null */
export const sumNum = (s: WorkoutSummary, key: string): number | null => {
  const v = s[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

// ---------------------------------------------------------------- heart-rate zones

export const ZONES = [
  { name: "Riscaldamento", color: "var(--zone-1)" },
  { name: "Consumo grassi", color: "var(--zone-2)" },
  { name: "Aerobica", color: "var(--zone-3)" },
  { name: "Anaerobica", color: "var(--zone-4)" },
  { name: "Estrema", color: "var(--zone-5)" },
] as const;

export interface HrZone {
  name: string;
  color: string;
  /** bpm range; lo null = "below hi", hi null = "above lo" */
  lo: number | null;
  hi: number | null;
  seconds: number;
}

export function userMaxHr(user: Pick<User, "birthday">, now = Date.now()): number | null {
  if (!user.birthday) return null;
  const b = new Date(user.birthday);
  if (Number.isNaN(b.getTime())) return null;
  const age = (now - b.getTime()) / (365.25 * 86400_000);
  return age > 5 && age < 110 ? Math.round(220 - age) : null;
}

/**
 * The 4 thresholds between the 5 zones. Taken from the zones the band wrote in the file
 * (high boundary of each zone, possibly preceded by "zone 0" and followed by the max);
 * otherwise Garmin's defaults: 60/70/80/90 % of the maximum heart rate.
 */
export function zoneThresholds(summary: WorkoutSummary, fallbackMaxHr: number | null): number[] | null {
  const z = summary._zones;
  const bounds = (z?.bounds ?? []).filter((b): b is number => typeof b === "number" && b > 0);
  if (bounds.length >= 5) return bounds.slice(0, -1).slice(-4);
  const max = z?.max_hr ?? fallbackMaxHr;
  return max ? [0.6, 0.7, 0.8, 0.9].map((k) => Math.round(max * k)) : null;
}

/** time spent in each zone, measured on the track points (each point lasts until the next one, at most 30 s) */
export function hrZones(records: Pick<WorkoutRecord, "timestamp" | "heart_rate">[], thresholds: number[]): HrZone[] {
  const seconds = [0, 0, 0, 0, 0];
  const hr = records.filter((r) => r.heart_rate);
  for (let i = 0; i < hr.length; i++) {
    const dt = i + 1 < hr.length ? Math.min(30, hr[i + 1].timestamp - hr[i].timestamp) : 1;
    let z = thresholds.findIndex((t) => hr[i].heart_rate! < t);
    if (z < 0) z = 4;
    seconds[z] += dt;
  }
  return ZONES.map((zone, i) => ({ ...zone, lo: i ? thresholds[i - 1] : null, hi: i < 4 ? thresholds[i] : null, seconds: seconds[i] }));
}

// ---------------------------------------------------------------- splits

export interface Split {
  index: number;
  distance_m: number;
  seconds: number;
  /** m/s */
  speed: number;
  avg_hr: number | null;
}

/** Splits every `every` metres from the distance written in the track points; the last one may be shorter. */
export function distanceSplits(records: Pick<WorkoutRecord, "timestamp" | "distance" | "heart_rate">[], every = 1000): Split[] {
  const rs = records.filter((r) => r.distance != null);
  if (rs.length < 2) return [];
  const out: Split[] = [];
  let startT = rs[0].timestamp;
  let startD = rs[0].distance!;
  let hrSum = 0;
  let hrN = 0;
  for (let i = 1; i < rs.length; i++) {
    const r = rs[i];
    if (r.heart_rate) {
      hrSum += r.heart_rate;
      hrN++;
    }
    const goal = startD + every;
    if (r.distance! >= goal) {
      // interpolate the moment the boundary was crossed
      const p = rs[i - 1];
      const k = (goal - p.distance!) / (r.distance! - p.distance! || 1);
      const t = p.timestamp + k * (r.timestamp - p.timestamp);
      out.push({ index: out.length + 1, distance_m: every, seconds: t - startT, speed: every / (t - startT || 1), avg_hr: hrN ? Math.round(hrSum / hrN) : null });
      startT = t;
      startD = goal;
      hrSum = 0;
      hrN = 0;
    }
  }
  const last = rs[rs.length - 1];
  const rest = last.distance! - startD;
  if (rest >= every * 0.05 && last.timestamp > startT)
    out.push({ index: out.length + 1, distance_m: rest, seconds: last.timestamp - startT, speed: rest / (last.timestamp - startT), avg_hr: hrN ? Math.round(hrSum / hrN) : null });
  return out;
}

// ---------------------------------------------------------------- series

/** centred moving average over `windowSec` seconds; breaks are kept (points further apart than `gap`) */
export function smooth(points: TimeValue[], windowSec: number): TimeValue[] {
  const out: TimeValue[] = [];
  let a = 0;
  let sum = 0;
  let b = 0;
  for (let i = 0; i < points.length; i++) {
    const t = points[i].timestamp;
    while (b < points.length && points[b].timestamp <= t + windowSec / 2) sum += points[b++].value;
    while (points[a].timestamp < t - windowSec / 2) sum -= points[a++].value;
    out.push({ timestamp: t, value: sum / (b - a) });
  }
  return out;
}

/** m/s → minutes per km as "m:ss" */
export function paceLabel(speedMs: number | null | undefined): string {
  if (!speedMs || speedMs <= 0) return "–";
  const s = Math.round(1000 / speedMs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
