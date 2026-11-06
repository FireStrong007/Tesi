/**
 * Imports a decoded FIT file into SQLite.
 * Logic follows Gadgetbridge's FitImporter (AGPL-3.0); differences:
 *  - timestamps are unix seconds everywhere
 *  - monitoring cumulative counters are converted to per-sample deltas here,
 *    keeping per-activity-type counter state across files (stored in `meta`).
 */
import { decodeFit, num, type FitRecord } from "../fit/decoder";
import { GARMIN_EPOCH } from "../garmin/time";
import type { SqlExecutor, Statement } from "./sql";

export interface ImportContext {
  deviceId: number;
  userId: number;
  fitFileId?: number | null;
}

export interface ImportResult {
  /** non-fatal problem: the file was imported only partially */
  warning?: string;
  fileType: number | null;
  records: number;
  counts: Record<string, number>;
  workoutId?: number;
}

/** FIT file_id.type values */
export const FitFileType = { ACTIVITY: 4, MONITOR_A: 15, MONITOR_DAILY: 28, MONITOR: 32, METRICS: 44, SLEEP: 49, HRV_STATUS: 68 } as const;

interface CounterState {
  steps: number;
  distance: number;
  calories: number;
}
interface MonitoringState {
  perType: Record<string, CounterState>;
  lastTs: number;
}

const SEMICIRCLE = 180 / 2 ** 31;

/**
 * Garmin monitoring counters are cumulative per activity type and reset at midnight.
 * Returns the increment since the previous value; a lower value means the counter reset.
 * The first value ever seen is counted entirely (the steps happened earlier that day).
 */
export function counterDelta(prev: number, cur: number): number {
  if (prev < 0) return cur;
  return cur >= prev ? cur - prev : cur;
}

export async function importFit(db: SqlExecutor, ctx: ImportContext, bytes: Uint8Array): Promise<ImportResult> {
  const fit = decodeFit(bytes);
  const { deviceId: d, userId: u } = ctx;
  const st: Statement[] = [];
  const counts: Record<string, number> = {};
  const add = (table: string, sql: string, params: (number | string | null)[]) => {
    st.push({ sql, params });
    counts[table] = (counts[table] ?? 0) + 1;
  };

  let fileType: number | null = null;
  let lastTs: number | null = null;
  let lastMonitoringTs: number | null = null;
  const monitoring = new Map<number, FitRecord[]>();
  const sessions: FitRecord[] = [];
  const trackRecords: FitRecord[] = [];
  const laps: FitRecord[] = [];
  const zoneRecs: FitRecord[] = [];
  let sportName: string | null = null;
  let sleepStart: number | null = null;

  for (const rec of fit.records) {
    const f = rec.fields;
    if (rec.timestamp !== null) lastTs = rec.timestamp;
    const ts = rec.timestamp ?? lastTs;

    switch (rec.name) {
      case "file_id":
        fileType = num(f.type);
        break;

      case "monitoring": {
        let t: number | null;
        const ts16 = num(rec.raw[26]);
        if (typeof rec.raw[253] === "number") t = rec.timestamp;
        else if (ts16 !== null && lastMonitoringTs !== null) {
          const ref: number = (lastMonitoringTs - GARMIN_EPOCH) & 0xffff;
          let diff: number = (ts16 & 0xffff) - ref;
          if (diff < -32768) diff += 65536;
          else if (diff > 32768) diff -= 65536;
          t = lastMonitoringTs + diff;
        } else t = lastMonitoringTs ?? rec.timestamp;
        if (t === null) break;
        lastMonitoringTs = t;
        const list = monitoring.get(t);
        if (list) list.push(rec);
        else monitoring.set(t, [rec]);
        break;
      }

      case "stress_level": {
        const t = num(f.stress_level_time) ?? ts;
        if (t === null) break;
        const stress = num(f.stress_level_value);
        if (stress !== null && stress >= 0)
          add("stress_sample", "INSERT OR REPLACE INTO stress_sample VALUES (?,?,?,?)", [d, u, t, stress]);
        const energy = num(f.body_energy);
        if (energy !== null && energy >= 0)
          add("body_energy_sample", "INSERT OR REPLACE INTO body_energy_sample VALUES (?,?,?,?)", [d, u, t, energy]);
        break;
      }

      case "spo2_data": {
        const spo2 = num(f.reading_spo2);
        if (ts === null || spo2 === null || spo2 <= 0) break;
        const mode = num(f.mode);
        const type = mode === 1 ? 1 : mode === 3 ? 2 : 0;
        add("spo2_sample", "INSERT OR REPLACE INTO spo2_sample VALUES (?,?,?,?,?)", [d, u, ts, spo2, type]);
        break;
      }

      case "respiration_rate": {
        const rate = num(f.respiration_rate);
        if (ts === null || rate === null || rate <= 0) break;
        add("respiratory_rate_sample", "INSERT OR REPLACE INTO respiratory_rate_sample VALUES (?,?,?,?)", [d, u, ts, rate]);
        break;
      }

      case "monitoring_hr_data": {
        const hr = num(f.current_day_resting_heart_rate) ?? num(f.resting_heart_rate);
        if (ts === null || hr === null) break;
        add("resting_hr_sample", "INSERT OR REPLACE INTO resting_hr_sample VALUES (?,?,?,?)", [d, u, ts, hr]);
        break;
      }

      case "monitoring_info": {
        const rmr = num(f.resting_metabolic_rate);
        if (ts === null || rmr === null) break;
        add("resting_metabolic_rate_sample", "INSERT OR REPLACE INTO resting_metabolic_rate_sample VALUES (?,?,?,?)", [d, u, ts, rmr]);
        break;
      }

      case "sleep_level": {
        const stage = num(f.sleep_level);
        if (ts === null || stage === null) break;
        add("sleep_stage_sample", "INSERT OR REPLACE INTO sleep_stage_sample VALUES (?,?,?,?)", [d, u, ts, stage]);
        break;
      }

      case "sleep_assessment": {
        const score = num(f.overall_sleep_score);
        if (ts === null || score === null) break;
        add(
          "sleep_stats_sample",
          `INSERT OR REPLACE INTO sleep_stats_sample (device_id,user_id,timestamp,sleep_score,awake_time_score,awakenings_count,
            awakenings_count_score,deep_sleep_score,light_sleep_score,rem_sleep_score,sleep_duration_score,sleep_quality_score,
            sleep_recovery_score,sleep_restlessness_score,interruptions_score,average_stress_during_sleep)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [d, u, ts, score, num(f.awake_time_score), num(f.awakenings_count), num(f.awakenings_count_score), num(f.deep_sleep_score),
            num(f.light_sleep_score), num(f.rem_sleep_score), num(f.sleep_duration_score), num(f.sleep_quality_score),
            num(f.sleep_recovery_score), num(f.sleep_restlessness_score), num(f.interruptions_score), num(f.average_stress_during_sleep)],
        );
        break;
      }

      case "sleep_restless_moments": {
        const c = num(f.restless_moments_count);
        const start = num(f.sleep_start);
        // on real bands sleep_start is not an absolute time (e.g. 7500): use the record's time then
        const t = start !== null && start > 1e8 ? start + GARMIN_EPOCH : ts;
        if (t === null || c === null) break;
        add("sleep_restless_sample", "INSERT OR REPLACE INTO sleep_restless_sample VALUES (?,?,?,?)", [d, u, t, c]);
        break;
      }

      case "nap_event": {
        const s = num(f.start_time);
        const e = num(f.end_time);
        if (s === null || e === null || num(f.is_deleted) === 1) break;
        add("nap_sample", "INSERT OR REPLACE INTO nap_sample VALUES (?,?,?,?)", [d, u, s, e]);
        break;
      }

      case "hrv_status_summary": {
        if (ts === null) break;
        const r = (v: unknown) => (typeof v === "number" ? Math.round(v) : null);
        add("hrv_summary_sample", "INSERT OR REPLACE INTO hrv_summary_sample VALUES (?,?,?,?,?,?,?,?,?,?)", [
          d, u, ts, r(f.weekly_average), r(f.last_night_average), r(f.last_night_5_min_high), r(f.baseline_low_upper),
          r(f.baseline_balanced_lower), r(f.baseline_balanced_upper), num(f.status),
        ]);
        break;
      }

      case "hrv_value": {
        const v = num(f.value);
        if (ts === null || v === null) break;
        add("hrv_value_sample", "INSERT OR REPLACE INTO hrv_value_sample VALUES (?,?,?,?)", [d, u, ts, Math.round(v)]);
        break;
      }

      case "event": {
        // event 74 = sleep: type 0 start, type 1 end (vívosmart 5 sleep files)
        if (num(f.event) !== 74 || ts === null) break;
        const type = num(f.event_type);
        if (type === 0) sleepStart = ts;
        else if (type === 1 && sleepStart !== null && ts > sleepStart) {
          add("sleep_session", 'INSERT OR REPLACE INTO sleep_session (device_id, user_id, start, "end") VALUES (?,?,?,?)', [d, u, sleepStart, ts]);
          sleepStart = null;
        }
        break;
      }

      case "battery": {
        const cap = num(f.capacity) ?? num(f.level);
        if (ts !== null && cap !== null)
          add("battery_level", "INSERT OR REPLACE INTO battery_level VALUES (?,?,?)", [d, ts, cap]);
        break;
      }

      case "session":
        sessions.push(rec);
        break;
      case "record":
        trackRecords.push(rec);
        break;
      case "lap":
        laps.push(rec);
        break;
      case "time_in_zone":
        zoneRecs.push(rec);
        break;
      case "sport":
        if (typeof f.name === "string") sportName = f.name;
        break;
      default:
        break;
    }
  }

  // ---- monitoring -> per-minute deltas
  if (monitoring.size) {
    const stateKey = `monitoring_state:${d}`;
    const row = (await db.all<{ value: string }>("SELECT value FROM meta WHERE key = ?", [stateKey]))[0];
    const state: MonitoringState = row ? JSON.parse(row.value) : { perType: {}, lastTs: 0 };
    const times = [...monitoring.keys()].sort((a, b) => a - b);
    for (const t of times) {
      const seen = t <= state.lastTs;
      let steps = 0;
      let dist = 0;
      let cal = 0;
      let hr: number | null = null;
      let intensity: number | null = null;
      let activityType: number | null = null;
      let moderate = 0;
      let vigorous = 0;
      for (const r of monitoring.get(t)!) {
        const ati = num(r.raw[24]);
        const type = num(r.raw[5]) ?? (ati !== null ? ati & 0x1f : null);
        if (type !== null) activityType = type;
        if (ati !== null) intensity = (ati >> 5) & 0x7;
        const h = num(r.raw[27]);
        if (h !== null && h > 0) hr = h;
        moderate += num(r.raw[33]) ?? 0;
        vigorous += num(r.raw[34]) ?? 0;
        if (seen) continue; // already imported (re-processing an older file): keep existing values
        const key = String(type ?? -1);
        const prev = state.perType[key] ?? { steps: -1, distance: -1, calories: -1 };
        // raw cycles == steps for walking/running (Gadgetbridge: scaled cycles * 2)
        const cycles = num(r.raw[3]);
        const distance = num(r.raw[2]); // cm
        const calories = num(r.raw[19]); // kcal
        if (cycles !== null) {
          steps += counterDelta(prev.steps, cycles);
          prev.steps = cycles;
        }
        if (distance !== null) {
          dist += counterDelta(prev.distance, distance);
          prev.distance = distance;
        }
        if (calories !== null) {
          cal += counterDelta(prev.calories, calories);
          prev.calories = calories;
        }
        state.perType[key] = prev;
      }
      if (!seen) state.lastTs = t;
      // Cumulative value at t covers the minute before it (same 60 s shift Gadgetbridge applies when reading)
      add("activity_sample",
        `INSERT INTO activity_sample (device_id,user_id,timestamp,activity_type,intensity,steps,heart_rate,distance_cm,active_calories)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(device_id,timestamp) DO UPDATE SET
           activity_type=COALESCE(excluded.activity_type,activity_type), intensity=COALESCE(excluded.intensity,intensity),
           steps=MAX(steps,excluded.steps), heart_rate=COALESCE(excluded.heart_rate,heart_rate),
           distance_cm=MAX(distance_cm,excluded.distance_cm), active_calories=MAX(active_calories,excluded.active_calories)`,
        [d, u, t - 60, activityType, intensity, steps, hr, dist, cal]);
      if (moderate || vigorous)
        add("intensity_minutes_sample", "INSERT OR REPLACE INTO intensity_minutes_sample VALUES (?,?,?,?,?)", [d, u, t, moderate, vigorous]);
    }
    st.push({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params: [stateKey, JSON.stringify(state)] });
  }

  await db.batch(st);

  // ---- workouts (activity files)
  let workoutId: number | undefined;
  if (sessions.length) {
    for (const s of sessions) {
      const f = s.fields;
      const start = num(f.start_time) ?? s.timestamp;
      if (start === null) continue;
      const elapsed = num(f.total_elapsed_time) ?? 0;
      const end = s.timestamp && s.timestamp > start ? s.timestamp : start + Math.round(elapsed);
      const summary: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(f)) if (v !== null && typeof v !== "bigint") summary[k] = v;
      // heart-rate zones the band used for this session (boundaries, max/resting HR, time per zone)
      const z = zoneRecs.find((r) => num(r.fields.reference_mesg) === 18 && (r.fields.reference_index ?? 0) === (f.message_index ?? 0)) ?? zoneRecs.find((r) => num(r.fields.reference_mesg) === 18);
      if (z) {
        const zf = z.fields;
        summary._zones = { bounds: zf.hr_zone_high_boundary ?? null, times: zf.time_in_hr_zone ?? null, max_hr: num(zf.max_heart_rate), resting_hr: num(zf.resting_heart_rate) };
      }
      await db.run("DELETE FROM workout WHERE device_id = ? AND start_time = ?", [d, start]);
      const res = await db.run(
        `INSERT INTO workout (device_id,user_id,fit_file_id,start_time,end_time,sport,sub_sport,name,elapsed_s,timer_s,distance_m,
          calories,avg_hr,max_hr,ascent_m,descent_m,steps,avg_speed,summary) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [d, u, ctx.fitFileId ?? null, start, end, num(f.sport), num(f.sub_sport), sportName, elapsed, num(f.total_timer_time),
          num(f.total_distance), num(f.total_calories), num(f.avg_heart_rate), num(f.max_heart_rate), num(f.total_ascent),
          num(f.total_descent), num(f.total_cycles), num(f.enhanced_avg_speed) ?? num(f.avg_speed), JSON.stringify(summary)],
      );
      workoutId = res.lastInsertRowid;
      counts.workout = (counts.workout ?? 0) + 1;
      const recs = trackRecords.filter((r) => r.timestamp !== null && r.timestamp >= start && r.timestamp <= end + 1);
      const rs: Statement[] = recs.map((r) => {
        const rf = r.fields;
        const lat = num(r.raw[0]);
        const lon = num(r.raw[1]);
        const cad = num(rf.cadence);
        return {
          sql: `INSERT OR REPLACE INTO workout_record (workout_id,timestamp,heart_rate,lat,lon,altitude,speed,distance,cadence,temperature)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
          params: [workoutId!, r.timestamp, num(rf.heart_rate), lat !== null ? lat * SEMICIRCLE : null, lon !== null ? lon * SEMICIRCLE : null,
            num(rf.enhanced_altitude) ?? num(rf.altitude), num(rf.enhanced_speed) ?? num(rf.speed), num(rf.distance),
            cad !== null ? cad + (num(rf.fractional_cadence) ?? 0) : null, num(rf.temperature)],
        };
      });
      const ls: Statement[] = laps
        .filter((l) => {
          const t = num(l.fields.start_time) ?? l.timestamp;
          return t !== null && t >= start && t <= end;
        })
        .map((l, i) => {
          const lf = l.fields;
          const cadence = (v: FitRecord["fields"][string], frac: FitRecord["fields"][string]) => (num(v) !== null ? num(v)! + (num(frac) ?? 0) : null);
          return {
            sql: `INSERT OR REPLACE INTO workout_lap (workout_id,idx,start_time,elapsed_s,timer_s,distance_m,calories,avg_speed,max_speed,
              avg_hr,max_hr,avg_cadence,max_cadence,ascent_m,descent_m,lap_trigger) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            params: [workoutId!, i, num(lf.start_time) ?? l.timestamp, num(lf.total_elapsed_time), num(lf.total_timer_time), num(lf.total_distance),
              num(lf.total_calories), num(lf.enhanced_avg_speed) ?? num(lf.avg_speed), num(lf.enhanced_max_speed) ?? num(lf.max_speed),
              num(lf.avg_heart_rate), num(lf.max_heart_rate), cadence(lf.avg_cadence, lf.avg_fractional_cadence),
              cadence(lf.max_cadence, lf.max_fractional_cadence), num(lf.total_ascent), num(lf.total_descent), num(lf.lap_trigger)],
          };
        });
      if (ls.length) await db.batch(ls);
      counts.workout_lap = (counts.workout_lap ?? 0) + ls.length;
      if (rs.length) await db.batch(rs);
      counts.workout_record = (counts.workout_record ?? 0) + rs.length;
    }
  }

  return { fileType, records: fit.records.length, counts, workoutId, warning: fit.error };
}
