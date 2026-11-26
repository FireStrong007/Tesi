/**
 * Read-only queries on the app's data tables (samples, daily totals, sleep), shared by the web app
 * and the server. All functions take a SqlExecutor, so they run on the browser's OPFS database, on
 * an in-memory database in tests and on the server's views (server/views.ts).
 */
import { DEFAULT_STRIDE_CM, asleepMinutes } from "../metrics";
import type { SqlExecutor } from "./sql";
import { addDays, startOfDay } from "../time-zone";

// ------------------------------------------------------------------ time helpers

// days of the study's time zone (time-zone.ts), re-exported for the queries' users
export { addDays, dayKey, startOfDay } from "../time-zone";

// ------------------------------------------------------------------ activity

export interface ActivityRow {
  timestamp: number;
  steps: number;
  heart_rate: number | null;
  intensity: number | null;
  activity_type: number | null;
  /** measured distance plus, for steps with none, the estimate (distance_est_cm) */
  distance_cm: number;
  /** the estimated part of distance_cm (metrics.DEFAULT_STRIDE_CM, views person_stride) */
  distance_est_cm: number;
  active_calories: number;
}

/**
 * Estimated distance of a minute whose steps have no measured distance (activity_sample.
 * distance_missing): steps × the person's average step length, or DEFAULT_STRIDE_CM. ?1 = user id.
 */
const ESTIMATE_SQL = `(CASE WHEN distance_missing = 1 AND steps > 0
  THEN ROUND(steps * COALESCE((SELECT stride_cm FROM person_stride WHERE user_id = ?1), ${DEFAULT_STRIDE_CM})) ELSE 0 END)`;

export async function activitySamples(db: SqlExecutor, userId: number, from: number, to: number): Promise<ActivityRow[]> {
  return db.all<ActivityRow>(
    `SELECT timestamp, steps, heart_rate, intensity, activity_type, COALESCE(distance_cm, 0) + ${ESTIMATE_SQL} AS distance_cm, ${ESTIMATE_SQL} AS distance_est_cm, active_calories
     FROM activity_sample WHERE user_id = ?1 AND timestamp >= ?2 AND timestamp < ?3 ORDER BY timestamp`,
    [userId, from, to],
  );
}

export interface DayTotals {
  day: number; // local start of day (unix)
  steps: number;
  /** measured plus estimated distance */
  distance_m: number;
  /** the estimated part of distance_m */
  distance_estimated_m: number;
  calories: number;
  active_minutes: number;
}

/** Totals per local day, aggregated per hour in SQL and folded into days in JS (DST-safe). */
export async function dailyTotals(db: SqlExecutor, userId: number, fromDay: number, toDay: number): Promise<DayTotals[]> {
  const rows = await db.all<{ h: number; steps: number; dist: number; est: number; cal: number; active: number }>(
    `SELECT (timestamp / 3600) AS h, SUM(steps) AS steps, SUM(distance_cm) AS dist, SUM(est) AS est, SUM(active_calories) AS cal,
            SUM(CASE WHEN intensity >= 2 OR steps >= 60 THEN 1 ELSE 0 END) AS active
     FROM (
       SELECT timestamp, steps, COALESCE(distance_cm, 0) + ${ESTIMATE_SQL} AS distance_cm, ${ESTIMATE_SQL} AS est, active_calories, intensity
       FROM activity_sample WHERE user_id = ?1 AND timestamp >= ?2 AND timestamp < ?3
       UNION ALL
       SELECT timestamp, steps, 0, 0, 0, NULL FROM live_sample WHERE user_id = ?1 AND timestamp >= ?2 AND timestamp < ?3 AND timestamp > ${COVERAGE_SQL}
     ) GROUP BY h`,
    [userId, fromDay, toDay],
  );
  const map = new Map<number, DayTotals>();
  for (let d = fromDay; d < toDay; d = addDays(d, 1)) map.set(d, { day: d, steps: 0, distance_m: 0, distance_estimated_m: 0, calories: 0, active_minutes: 0 });
  for (const r of rows) {
    const day = startOfDay(r.h * 3600);
    const t = map.get(day);
    if (!t) continue;
    t.steps += r.steps;
    t.distance_m += r.dist / 100;
    t.distance_estimated_m += r.est / 100;
    t.calories += r.cal;
    t.active_minutes += r.active;
  }
  return [...map.values()];
}

/**
 * End of the period covered by synced FIT monitoring data (rows with an activity type come
 * from the band's files). Live rows after this point fill the gap until the next sync.
 * Uses parameter ?1 = user id.
 */
export const COVERAGE_SQL = "(SELECT COALESCE(MAX(timestamp), 0) FROM activity_sample WHERE user_id = ?1 AND activity_type IS NOT NULL)";

export interface LiveRow {
  timestamp: number;
  heart_rate: number | null;
  steps: number;
  body_battery: number | null;
  respiration: number | null;
  spo2: number | null;
}

/** Live-channel minutes not yet covered by synced FIT data. */
export async function liveSamples(db: SqlExecutor, userId: number, from: number, to: number): Promise<LiveRow[]> {
  return db.all<LiveRow>(
    `SELECT timestamp, heart_rate, steps, body_battery, respiration, spo2 FROM live_sample
     WHERE user_id = ?1 AND timestamp >= ?2 AND timestamp < ?3 AND timestamp > ${COVERAGE_SQL} ORDER BY timestamp`,
    [userId, from, to],
  );
}

export interface TimeValue {
  timestamp: number;
  value: number;
}

const series = (table: string, col: string) => (db: SqlExecutor, userId: number, from: number, to: number) =>
  db.all<TimeValue>(`SELECT timestamp, ${col} AS value FROM ${table} WHERE user_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp`, [userId, from, to]);

export const stressSamples = series("stress_sample", "stress");
export const bodyEnergySamples = series("body_energy_sample", "energy");
export const spo2Samples = series("spo2_sample", "spo2");
export const respiratorySamples = series("respiratory_rate_sample", "rate");
export const restingHrSamples = series("resting_hr_sample", "heart_rate");
export const hrvValueSamples = series("hrv_value_sample", "value");
/** HeartBridge (Gima): CVRR next to each HRV value, blood pressure, body temperature (valid values only, gima/views.ts) */
export const cvrrSamples = series("hrv_value_sample", "cvrr");
export const temperatureSamples = series("body_temperature_sample", "temperature");
export interface BloodPressure {
  timestamp: number;
  systolic: number;
  diastolic: number;
}
/** the latest blood pressure measurement before `before` (the Home's «ultima misura») */
export async function lastBloodPressure(db: SqlExecutor, userId: number, before: number): Promise<BloodPressure | null> {
  const [r] = await db.all<BloodPressure>("SELECT timestamp, systolic, diastolic FROM blood_pressure_sample WHERE user_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 1", [userId, before]);
  return r ?? null;
}
export const bloodPressureSamples = (db: SqlExecutor, userId: number, from: number, to: number) =>
  db.all<BloodPressure>("SELECT timestamp, systolic, diastolic FROM blood_pressure_sample WHERE user_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp", [userId, from, to]);
export const heartRateSamples = (db: SqlExecutor, userId: number, from: number, to: number) =>
  db.all<TimeValue>("SELECT timestamp, heart_rate AS value FROM activity_sample WHERE user_id = ? AND timestamp >= ? AND timestamp < ? AND heart_rate > 0 ORDER BY timestamp", [userId, from, to]);

export interface HrvSummary {
  timestamp: number;
  weekly_average: number | null;
  last_night_average: number | null;
  last_night_5min_high: number | null;
  baseline_low_upper: number | null;
  baseline_balanced_lower: number | null;
  baseline_balanced_upper: number | null;
  status: number | null;
}

export async function hrvSummaries(db: SqlExecutor, userId: number, from: number, to: number): Promise<HrvSummary[]> {
  return db.all("SELECT * FROM hrv_summary_sample WHERE user_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp", [userId, from, to]);
}

export interface IntensityRow {
  timestamp: number;
  moderate: number;
  vigorous: number;
}
export async function intensityMinutes(db: SqlExecutor, userId: number, from: number, to: number): Promise<IntensityRow[]> {
  return db.all("SELECT timestamp, moderate, vigorous FROM intensity_minutes_sample WHERE user_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp", [userId, from, to]);
}

// ------------------------------------------------------------------ sleep

export interface SleepSegment {
  start: number;
  end: number;
  stage: number; // 1 awake, 2 light, 3 deep, 4 rem (other codes, e.g. Gima's unknown ones: no segment)
}

export interface SleepSession {
  start: number;
  end: number;
  segments: SleepSegment[];
  minutes: { awake: number; light: number; deep: number; rem: number };
  score: number | null;
  /** local day the session is assigned to (the day you wake up) */
  day: number;
}

/** Builds sleep sessions from stage samples (each stage lasts until the next sample). */
export async function sleepSessions(db: SqlExecutor, userId: number, from: number, to: number): Promise<SleepSession[]> {
  const lo = from - 14 * 3600;
  const rows = await db.all<{ timestamp: number; stage: number }>(
    "SELECT timestamp, stage FROM sleep_stage_sample WHERE user_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp",
    [userId, lo, to],
  );
  const bounds = await db.all<{ start: number; end: number }>(
    'SELECT start, "end" FROM sleep_session WHERE user_id = ? AND "end" > ? AND start < ? ORDER BY start',
    [userId, lo, to],
  );
  const scores = await db.all<{ timestamp: number; sleep_score: number }>(
    "SELECT timestamp, sleep_score FROM sleep_stats_sample WHERE user_id = ? AND timestamp >= ? AND timestamp < ? + 43200 ORDER BY timestamp",
    [userId, lo, to],
  );
  const empty = (start: number, end: number): SleepSession => ({ start, end, segments: [], minutes: { awake: 0, light: 0, deep: 0, rem: 0 }, score: null, day: 0 });
  const addSegment = (s: SleepSession, start: number, end: number, rawStage: number) => {
    if (end <= start) return;
    const stage = rawStage === 0 ? 1 : rawStage;
    // an unknown stage (gima/views.ts UNKNOWN_STAGE) is no sleep stage: neither a segment nor minutes
    if (stage < 1 || stage > 4) return;
    const last = s.segments[s.segments.length - 1];
    if (last && last.stage === stage && last.end === start) last.end = end;
    else s.segments.push({ start, end, stage });
    const mins = (end - start) / 60;
    if (stage === 1) s.minutes.awake += mins;
    else if (stage === 2) s.minutes.light += mins;
    else if (stage === 3) s.minutes.deep += mins;
    else if (stage === 4) s.minutes.rem += mins;
  };

  const sessions: SleepSession[] = [];
  const used = new Set<number>();
  // Garmin stage samples are the UPPER bound of a stage (Gadgetbridge, GarminSleepSessionProvider):
  // the stage written at time t lasted from the previous sample (or the sleep start) until t.
  // 1) nights with start/end written by the band
  for (const b of bounds) {
    const s = empty(b.start, b.end);
    let prev = b.start;
    rows.forEach((r, i) => {
      if (r.timestamp <= b.start || r.timestamp > b.end || used.has(i)) return;
      used.add(i);
      addSegment(s, prev, r.timestamp, r.stage);
      prev = r.timestamp;
    });
    // no stages sent by the band: the whole night as light sleep (like Gadgetbridge)
    if (!s.segments.length && prev === b.start) addSegment(s, b.start, b.end, 2);
    sessions.push(s);
  }
  // 2) stages without recorded bounds (files imported before v4): same rule; a gap longer than
  //    3 hours starts a new night, and the first sample of a night covers the minute before it
  const loose = rows.filter((_, i) => !used.has(i));
  let cur: SleepSession | null = null;
  for (const r of loose) {
    if (!cur || r.timestamp - cur.end > 3 * 3600) {
      cur = empty(r.timestamp - 60, r.timestamp);
      sessions.push(cur);
    }
    addSegment(cur, cur.end, r.timestamp, r.stage);
    cur.end = r.timestamp;
  }
  sessions.sort((a, b) => a.start - b.start);
  for (const s of sessions) {
    s.day = startOfDay(s.end);
    const sc = scores.find((x) => x.timestamp >= s.start - 3600 && x.timestamp <= s.end + 6 * 3600);
    s.score = sc?.sleep_score ?? null;
  }
  return sessions.filter((s) => s.end > from && s.end <= to + 43200 && s.end - s.start >= 20 * 60);
}

export const sleepTotal = (s: SleepSession) => asleepMinutes(s.minutes);

// ------------------------------------------------------------------ ECG (HeartBridge)

export interface EcgRecording {
  timestamp: number;
  /** ECG_MEASUREMENTS.start_measure_ms: the key of the samples */
  start_ms: number;
  duration_s: number | null;
  sample_count: number;
  heart: number | null;
  sbp: number | null;
  dbp: number | null;
  hrv: number | null;
  is_afib: number | null;
  diagnose_type: number | null;
  ai_heart: number | null;
}

/** the recordings in [from, to), newest first (gima/views.ts: invalid values already NULL) */
export const ecgRecordings = (db: SqlExecutor, userId: number, from: number, to: number) =>
  db.all<EcgRecording>("SELECT * FROM ecg_recording WHERE user_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp DESC", [userId, from, to]);

/** the samples of one recording, from the copy of the server's table (gima/ecg.ts decodes them) */
export async function ecgBlob(db: SqlExecutor, userId: number, startMs: number): Promise<Uint8Array | null> {
  const [r] = await db.all<{ ecg_data: Uint8Array }>("SELECT ecg_data FROM ECG_MEASUREMENTS WHERE USER_ID = ? AND start_measure_ms = ? LIMIT 1", [userId, startMs]);
  return r?.ecg_data ?? null;
}
