/** Per-day aggregates for the week / month views. */
import { stressMinutes, type StressKey } from "./metrics";
import { COVERAGE_SQL, addDays, dailyTotals, stressSamples, hrvSummaries, intensityMinutes, sleepSessions, startOfDay, type DayTotals, type HrvSummary, type SleepSession } from "./db/repo";
import type { SqlExecutor } from "./db/sql";

export interface DayAgg {
  day: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

/** avg/min/max of a column per local day (hour buckets in SQL, folded per day in JS, DST-safe). */
export async function dailyStats(db: SqlExecutor, table: string, col: string, userId: number, from: number, to: number, where = ""): Promise<DayAgg[]> {
  const rows = await db.all<{ h: number; s: number; n: number; mi: number; ma: number }>(
    `SELECT timestamp / 3600 AS h, SUM(${col}) AS s, COUNT(*) AS n, MIN(${col}) AS mi, MAX(${col}) AS ma
     FROM ${table} WHERE user_id = ? AND timestamp >= ? AND timestamp < ? ${where} GROUP BY h`,
    [userId, from, to],
  );
  const map = new Map<number, { s: number; n: number; mi: number; ma: number }>();
  for (const r of rows) {
    const d = startOfDay(r.h * 3600);
    const a = map.get(d);
    if (a) {
      a.s += r.s;
      a.n += r.n;
      a.mi = Math.min(a.mi, r.mi);
      a.ma = Math.max(a.ma, r.ma);
    } else map.set(d, { s: r.s, n: r.n, mi: r.mi, ma: r.ma });
  }
  const out: DayAgg[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) {
    const a = map.get(d);
    out.push({ day: d, avg: a ? a.s / a.n : null, min: a?.mi ?? null, max: a?.ma ?? null, count: a?.n ?? 0 });
  }
  return out;
}

/** Combines two per-day aggregates (e.g. synced data + live minutes not yet synced). */
export function mergeAgg(a: DayAgg[], b: DayAgg[]): DayAgg[] {
  return a.map((x, i) => {
    const y = b[i];
    if (!y || !y.count) return x;
    if (!x.count) return y;
    const count = x.count + y.count;
    return {
      day: x.day,
      avg: ((x.avg ?? 0) * x.count + (y.avg ?? 0) * y.count) / count,
      min: Math.min(x.min ?? Infinity, y.min ?? Infinity),
      max: Math.max(x.max ?? -Infinity, y.max ?? -Infinity),
      count,
    };
  });
}

const liveStats = (db: SqlExecutor, col: string, userId: number, from: number, to: number) =>
  dailyStats(db, "live_sample", col, userId, from, to, `AND ${col} IS NOT NULL AND timestamp > ${COVERAGE_SQL}`);

export interface RangeData {
  days: number[];
  totals: DayTotals[];
  sleep: (SleepSession | null)[];
  hr: DayAgg[];
  resting: DayAgg[];
  stress: DayAgg[];
  energy: DayAgg[];
  spo2: DayAgg[];
  resp: DayAgg[];
  hrv: (HrvSummary | null)[];
  intensity: { day: number; moderate: number; vigorous: number }[];
  /** minutes per stress level, per day */
  stressByLevel: Record<StressKey, number>[];
  /** resting metabolic rate per day (kcal/day): last value reported by the band up to that day */
  rmr: (number | null)[];
}

export async function loadRange(db: SqlExecutor, userId: number, from: number, to: number): Promise<RangeData> {
  const days: number[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  const [totals, sleeps, fitHr, resting, stress, fitEnergy, spo2, fitResp, hrvs, im, liveHr, liveEnergy, liveResp] = await Promise.all([
    dailyTotals(db, userId, from, to),
    sleepSessions(db, userId, from - 12 * 3600, to),
    dailyStats(db, "activity_sample", "heart_rate", userId, from, to, "AND heart_rate > 0"),
    dailyStats(db, "resting_hr_sample", "heart_rate", userId, from, to + 3600),
    dailyStats(db, "stress_sample", "stress", userId, from, to),
    dailyStats(db, "body_energy_sample", "energy", userId, from, to),
    dailyStats(db, "spo2_sample", "spo2", userId, from, to),
    dailyStats(db, "respiratory_rate_sample", "rate", userId, from, to),
    hrvSummaries(db, userId, from, to),
    intensityMinutes(db, userId, from, to),
    liveStats(db, "heart_rate", userId, from, to),
    liveStats(db, "body_battery", userId, from, to),
    liveStats(db, "respiration", userId, from, to),
  ]);
  const [stressRows, rmrRows] = await Promise.all([
    stressSamples(db, userId, from, to),
    db.all<{ timestamp: number; rate: number }>("SELECT timestamp, rate FROM resting_metabolic_rate_sample WHERE user_id = ? AND timestamp < ? ORDER BY timestamp", [userId, to]),
  ]);
  const stressByLevel = days.map((d) => stressMinutes(stressRows.filter((r) => r.timestamp >= d && r.timestamp < addDays(d, 1))));
  const rmr = days.map((d) => {
    const end = addDays(d, 1);
    let v: number | null = null;
    for (const r of rmrRows) if (r.timestamp < end) v = r.rate;
    return v;
  });
  const hr = mergeAgg(fitHr, liveHr);
  const energy = mergeAgg(fitEnergy, liveEnergy);
  const resp = mergeAgg(fitResp, liveResp);
  const sleepByDay = days.map((d) => {
    const s = sleeps.filter((x) => x.day === d);
    return s.sort((a, b) => b.end - b.start - (a.end - a.start))[0] ?? null;
  });
  const hrvByDay = days.map((d) => hrvs.filter((h) => startOfDay(h.timestamp) === d).pop() ?? null);
  const intensity = days.map((d) => {
    const rows = im.filter((r) => startOfDay(r.timestamp) === d);
    return { day: d, moderate: rows.reduce((s, r) => s + r.moderate, 0), vigorous: rows.reduce((s, r) => s + r.vigorous, 0) };
  });
  return { days, totals, sleep: sleepByDay, hr, resting, stress, energy, spo2, resp, hrv: hrvByDay, intensity, stressByLevel, rmr };
}
