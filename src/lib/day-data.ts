/** Loads and summarises everything shown for one day (dashboard + daily charts). */
import type { MinuteSlot } from "@/components/charts/charts";
import { STAGE_COLOR, STAGE_LABEL } from "./colors";
import {
  activitySamples,
  addDays,
  bodyEnergySamples,
  hrvSummaries,
  intensityMinutes,
  liveSamples,
  respiratorySamples,
  restingHrSamples,
  sleepSessions,
  sleepTotal,
  spo2Samples,
  stressSamples,
  type ActivityRow,
  type HrvSummary,
  type SleepSession,
  type TimeValue,
} from "./db/repo";
import type { SqlExecutor } from "./db/sql";
import { cumulative, energyFlow, stats, stressAverage, stressMinutes, within, type SeriesStats, type StressKey } from "./metrics";

export interface DayData {
  from: number;
  to: number;
  samples: ActivityRow[];
  steps: number;
  distanceM: number;
  activeCalories: number;
  activeMinutes: number;
  intensityModerate: number;
  intensityVigorous: number;
  hr: TimeValue[];
  hrMin: number | null;
  hrMax: number | null;
  hrAvg: number | null;
  restingHr: number | null;
  stress: TimeValue[];
  stressAvg: number | null;
  energy: TimeValue[];
  energyNow: number | null;
  energyMax: number | null;
  energyMin: number | null;
  spo2: TimeValue[];
  spo2Avg: number | null;
  resp: TimeValue[];
  respAvg: number | null;
  sleep: SleepSession | null;
  sleepMinutes: number;
  hrv: HrvSummary | null;
  /** running totals during the day (charts "Passi" and "Calorie") */
  stepsCumulative: TimeValue[];
  caloriesCumulative: TimeValue[];
  /** band's resting metabolic rate for this day (kcal/day), null if not reported */
  rmr: number | null;
  stressByLevel: Record<StressKey, number>;
  energyCharged: number;
  energyDrained: number;
  /** values measured during the main sleep of this day */
  sleepHr: TimeValue[];
  sleepSpo2: TimeValue[];
  sleepResp: TimeValue[];
  sleepHrStats: SeriesStats;
  restlessMoments: number | null;
  slots: MinuteSlot[];
  ring: { color: string }[];
  hasData: boolean;
}

const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

export async function loadDay(db: SqlExecutor, userId: number, from: number): Promise<DayData> {
  const to = addDays(from, 1);
  const [fitSamples, stress, fitEnergy, fitSpo2, fitResp, resting, hrvs, sleeps, im, live] = await Promise.all([
    activitySamples(db, userId, from, to),
    stressSamples(db, userId, from, to),
    bodyEnergySamples(db, userId, from, to),
    spo2Samples(db, userId, from - 6 * 3600, to),
    respiratorySamples(db, userId, from - 14 * 3600, to),
    restingHrSamples(db, userId, from, to + 3600),
    hrvSummaries(db, userId, from, to),
    sleepSessions(db, userId, from - 12 * 3600, to),
    intensityMinutes(db, userId, from, to),
    liveSamples(db, userId, from - 6 * 3600, to),
  ]);
  const [rmrRow, restlessRows, sleepHrRows] = await Promise.all([
    db.all<{ rate: number }>("SELECT rate FROM resting_metabolic_rate_sample WHERE user_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 1", [userId, to]),
    db.all<{ timestamp: number; count: number }>("SELECT timestamp, count FROM sleep_restless_sample WHERE user_id = ? AND timestamp >= ? AND timestamp < ?", [userId, from - 14 * 3600, to]),
    // heart rate of the night before (the main sleep may start before midnight)
    db.all<TimeValue>("SELECT timestamp, heart_rate AS value FROM activity_sample WHERE user_id = ? AND timestamp >= ? AND timestamp < ? AND heart_rate > 0 ORDER BY timestamp", [userId, from - 14 * 3600, from]),
  ]);

  // Live minutes (band connected, not yet synced) continue the synced series up to "now".
  const liveToday = live.filter((l) => l.timestamp >= from);
  const samples: ActivityRow[] = [
    ...fitSamples,
    ...liveToday.map((l) => ({
      timestamp: l.timestamp,
      steps: l.steps,
      heart_rate: l.heart_rate,
      intensity: l.steps >= 100 ? 2 : l.steps >= 30 ? 1 : 0,
      activity_type: null,
      distance_cm: 0,
      active_calories: 0,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp);
  const after = <T extends TimeValue>(series: T[], extra: TimeValue[]) => {
    const last = series.length ? series[series.length - 1].timestamp : -Infinity;
    return [...series, ...extra.filter((p) => p.timestamp > last)];
  };
  const energy = after(fitEnergy, liveToday.filter((l) => l.body_battery != null).map((l) => ({ timestamp: l.timestamp, value: l.body_battery! })));
  const resp = after(within(fitResp, from, to), liveToday.filter((l) => l.respiration != null).map((l) => ({ timestamp: l.timestamp, value: l.respiration! })));
  const spo2 = after(fitSpo2, live.filter((l) => l.spo2 != null).map((l) => ({ timestamp: l.timestamp, value: l.spo2! })));

  // the main sleep of this day is the longest session ending on this day
  const daySleeps = sleeps.filter((s) => s.end > from && s.end <= to);
  const sleep = daySleeps.sort((a, b) => sleepTotal(b) - sleepTotal(a))[0] ?? null;
  const allSegments = sleeps.flatMap((s) => s.segments).filter((g) => g.end > from && g.start < to);

  const hr = samples.filter((s) => s.heart_rate && s.heart_rate > 0).map((s) => ({ timestamp: s.timestamp, value: s.heart_rate! }));
  const hrVals = hr.map((h) => h.value);
  const steps = samples.reduce((s, r) => s + r.steps, 0);
  const activeMinutes = samples.filter((s) => (s.intensity ?? 0) >= 2 || s.steps >= 60).length;

  // 5-minute slots for the activity & sleep chart
  const now = Date.now() / 1000;
  const slots: MinuteSlot[] = [];
  const byBucket = new Map<number, ActivityRow[]>();
  for (const s of samples) {
    const b = Math.floor((s.timestamp - from) / 300);
    const l = byBucket.get(b);
    if (l) l.push(s);
    else byBucket.set(b, [s]);
  }
  const SLEEP_LEVEL: Record<number, number> = { 1: 0.14, 2: 0.28, 3: 0.42, 4: 0.34 };
  let lastWorn = -999;
  for (let b = 0; b < 288; b++) {
    const t = from + b * 300;
    if (t > now) break;
    const seg = allSegments.find((g) => t + 150 >= g.start && t + 150 < g.end);
    if (seg) {
      slots.push({ t, level: SLEEP_LEVEL[seg.stage] ?? 0.2, color: STAGE_COLOR[seg.stage], label: `Sonno: ${STAGE_LABEL[seg.stage] ?? "–"}` });
      lastWorn = b;
      continue;
    }
    const rows = byBucket.get(b);
    if (rows) {
      lastWorn = b;
      const st = rows.reduce((s, r) => s + r.steps, 0);
      const intense = rows.some((r) => (r.intensity ?? 0) >= 3 || r.activity_type === 1);
      slots.push({ t, level: Math.max(0.04, Math.min(1, st / 650)), color: intense ? "var(--calories)" : "var(--steps)", label: `${intense ? "Attività intensa" : "Attività"}: ${st} passi` });
    } else if (b - lastWorn > 3) {
      slots.push({ t, level: 0.06, color: "var(--muted-foreground)", label: "Non indossato" });
    }
  }

  // 15-minute slots for the 24h ring
  const ring: { color: string }[] = [];
  for (let q = 0; q < 96; q++) {
    const t = from + q * 900;
    if (t > now) {
      ring.push({ color: "transparent" });
      continue;
    }
    const seg = allSegments.find((g) => t + 450 >= g.start && t + 450 < g.end);
    if (seg) {
      ring.push({ color: seg.stage === 1 ? "var(--sleep-awake)" : seg.stage === 3 ? "var(--sleep-deep)" : "var(--sleep-light)" });
      continue;
    }
    const rows = [0, 1, 2].flatMap((k) => byBucket.get(q * 3 + k) ?? []);
    const st = rows.reduce((s, r) => s + r.steps, 0);
    ring.push({ color: !rows.length ? "transparent" : st > 250 ? "var(--steps)" : "color-mix(in oklch, var(--steps) 30%, transparent)" });
  }

  const energyVals = energy.map((e) => e.value);
  const flow = energyFlow(energy);
  const allHr: TimeValue[] = [...sleepHrRows, ...hr];
  const sleepHr = sleep ? within(allHr, sleep.start, sleep.end) : [];
  const restless = sleep ? restlessRows.find((r) => r.timestamp >= sleep.start - 3600 && r.timestamp <= sleep.end + 6 * 3600) : undefined;
  const lastResting = resting.length ? resting[resting.length - 1].value : null;

  return {
    from,
    to,
    samples,
    steps,
    distanceM: samples.reduce((s, r) => s + r.distance_cm, 0) / 100,
    activeCalories: samples.reduce((s, r) => s + r.active_calories, 0),
    activeMinutes,
    intensityModerate: im.reduce((s, r) => s + r.moderate, 0),
    intensityVigorous: im.reduce((s, r) => s + r.vigorous, 0),
    hr,
    hrMin: hrVals.length ? Math.min(...hrVals) : null,
    hrMax: hrVals.length ? Math.max(...hrVals) : null,
    hrAvg: avg(hrVals),
    restingHr: lastResting,
    stress,
    stressAvg: stressAverage(stress),
    energy,
    energyNow: energyVals.length ? energyVals[energyVals.length - 1] : null,
    energyMax: energyVals.length ? Math.max(...energyVals) : null,
    energyMin: energyVals.length ? Math.min(...energyVals) : null,
    spo2: spo2.filter((s) => s.timestamp >= (sleep?.start ?? from) - 3600 && s.timestamp < to),
    spo2Avg: avg(spo2.filter((s) => s.timestamp >= from - 6 * 3600 && s.timestamp < to).map((s) => s.value)),
    resp,
    respAvg: avg(resp.map((r) => r.value)),
    sleep,
    sleepMinutes: sleep ? sleepTotal(sleep) : 0,
    hrv: hrvs.length ? hrvs[hrvs.length - 1] : null,
    stepsCumulative: cumulative(samples, (r) => r.steps, from),
    caloriesCumulative: cumulative(samples, (r) => r.active_calories, from),
    rmr: rmrRow[0]?.rate ?? null,
    stressByLevel: stressMinutes(stress),
    energyCharged: flow.charged,
    energyDrained: flow.drained,
    sleepHr,
    sleepSpo2: sleep ? within(spo2, sleep.start, sleep.end) : [],
    sleepResp: sleep ? within([...fitResp.filter((r) => r.timestamp < from), ...resp], sleep.start, sleep.end) : [],
    sleepHrStats: stats(sleepHr.map((h) => h.value)),
    restlessMoments: restless?.count ?? null,
    slots,
    ring,
    hasData: samples.length > 0 || !!sleep || stress.length > 0,
  };
}
