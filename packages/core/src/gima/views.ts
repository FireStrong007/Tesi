/**
 * The Gima (Sportpix) research server's tables shown as the app's own tables, like server/views.ts
 * does for Garmin: the same names and columns, so that loadDay, loadRange, the daily values and
 * the comparison run unchanged. Every time is in milliseconds (UTC) on the server, in seconds here.
 *
 * The values the watch or its app write when nothing was measured are filtered HERE, in one place
 * (GIMA_VALID), never in the charts: 0 for heart rate, blood pressure, HRV, SpO2, respiration and
 * durations; body temperatures outside 30–43 °C (the real data have 0.15 °C in most rows); ECG
 * ai_heart above 300.
 *
 * - activity_sample: one row per 30-minute block (steps, distance, active calories of the block,
 *   not cumulative), at the block's start, plus one row per heart rate measurement (about every
 *   18 minutes): the valid day rule counts the hours with a heart rate like on Garmin.
 * - sleep: stages come as start + DURATION_SEC (241 deep, 242 light; any other code is unknown and
 *   counts for no stage). The app's stage rows are end boundaries (db/queries.sleepSessions), and a
 *   gap of less than 3 hours between two stages is time awake in the same night: one night can be
 *   split in two segments (e.g. 23:29–06:04 and 06:26–07:34 in the real data), and the night is the
 *   whole of them (sleep_session).
 */
import { APP_COLUMNS, emptyView, msView, type LocalView } from "../server/views";
import { MIN_STRIDE_MINUTES, MIN_STRIDE_STEPS } from "../metrics";

/** Gima's sleep stage codes */
export const GIMA_STAGE = { DEEP: 241, LIGHT: 242 } as const;
/** the app's sleep stages (db/queries.SleepSegment): 1 awake, 2 light, 3 deep, 4 REM; 5 = unknown */
export const UNKNOWN_STAGE = 5;
/** a pause between two sleep stages shorter than this is awake time in the same night */
export const NIGHT_GAP_S = 3 * 3600;

/** what counts as measured; everything else is "not measured" and left out */
export const GIMA_VALID = {
  heartRate: "HEART_RATE > 0",
  bloodPressure: "BP_SYSTOLIC > 0 AND BP_DIASTOLIC > 0",
  spo2: "SPO2 > 0",
  respiration: "RESPIRATORY_RATE > 0",
  hrv: "HRV > 0",
  temperature: "TEMPERATURE BETWEEN 30 AND 43",
  /** above this the device's ECG heart rate is not a heart rate */
  aiHeartMax: 300,
} as const;

const since = (from: number | null, col = "TIMESTAMP") => (from == null ? "" : ` AND ${col} >= ${from * 1000}`);

const ACTIVITY: LocalView = {
  name: "activity_sample",
  select: (from) => `
SELECT DEVICE_ID AS device_id, USER_ID AS user_id, TIMESTAMP / 1000 AS timestamp, NULL AS activity_type, NULL AS intensity,
  CASE WHEN STEPS >= 0 THEN STEPS END AS steps, CASE WHEN DISTANCE_CM >= 0 THEN DISTANCE_CM END AS distance_cm,
  CASE WHEN ACTIVE_CALORIES >= 0 THEN ACTIVE_CALORIES END AS active_calories, NULL AS heart_rate, 0 AS distance_missing
FROM GIMA_ACTIVITY_SAMPLE WHERE 1${since(from)}
UNION ALL
SELECT DEVICE_ID, USER_ID, TIMESTAMP / 1000, NULL, NULL, NULL, NULL, NULL, HEART_RATE, 0
FROM GIMA_HEART_RATE_SAMPLE WHERE ${GIMA_VALID.heartRate}${since(from)}`,
};

/** stages with their end, and the end of the previous stage of the same watch */
const STAGES = `
SELECT USER_ID, DEVICE_ID, TIMESTAMP / 1000 AS start, TIMESTAMP / 1000 + DURATION_SEC AS "end", STAGE,
  LAG(TIMESTAMP / 1000 + DURATION_SEC) OVER (PARTITION BY USER_ID, DEVICE_ID ORDER BY TIMESTAMP) AS prev_end
FROM GIMA_SLEEP_STAGE_SAMPLE WHERE DURATION_SEC > 0`;

const SLEEP_STAGES: LocalView = {
  name: "sleep_stage_sample",
  // computed over every stage (the previous stage may be before `from`), then cut
  select: (from) => `
SELECT device_id, user_id, timestamp, stage FROM (
  SELECT DEVICE_ID AS device_id, USER_ID AS user_id, "end" AS timestamp,
    CASE STAGE WHEN ${GIMA_STAGE.DEEP} THEN 3 WHEN ${GIMA_STAGE.LIGHT} THEN 2 ELSE ${UNKNOWN_STAGE} END AS stage
  FROM (${STAGES})
  UNION ALL
  -- the pause before a stage, within the same night: awake until the stage starts
  SELECT DEVICE_ID, USER_ID, start, 1 FROM (${STAGES}) WHERE prev_end IS NOT NULL AND start - prev_end >= 60 AND start - prev_end < ${NIGHT_GAP_S}
)${from == null ? "" : ` WHERE timestamp >= ${from}`}`,
};

const SLEEP_SESSIONS: LocalView = {
  name: "sleep_session",
  time: "start",
  updatedBy: '"end"',
  select: (from) => `
SELECT device_id, user_id, start, "end" FROM (
  SELECT DEVICE_ID AS device_id, USER_ID AS user_id, MIN(start) AS start, MAX("end") AS "end" FROM (
    SELECT *, SUM(CASE WHEN prev_end IS NULL OR start - prev_end >= ${NIGHT_GAP_S} THEN 1 ELSE 0 END)
      OVER (PARTITION BY USER_ID, DEVICE_ID ORDER BY start ROWS UNBOUNDED PRECEDING) AS night
    FROM (${STAGES})
  ) GROUP BY USER_ID, DEVICE_ID, night
)${from == null ? "" : ` WHERE "end" >= ${from}`}`,
};

const ECG: LocalView = {
  name: "ecg_recording",
  select: (from) => `
SELECT DEVICE_ID AS device_id, USER_ID AS user_id, start_measure_ms / 1000 AS timestamp, start_measure_ms AS start_ms,
  CASE WHEN duration_ms > 0 THEN duration_ms / 1000.0 END AS duration_s, sample_count,
  NULLIF(heart, 0) AS heart, NULLIF(sbp, 0) AS sbp, NULLIF(dbp, 0) AS dbp, NULLIF(hrv, 0) AS hrv, is_afib, diagnose_type,
  CASE WHEN ai_heart > 0 AND ai_heart <= ${GIMA_VALID.aiHeartMax} THEN ai_heart END AS ai_heart
FROM ECG_MEASUREMENTS WHERE 1${since(from, "start_measure_ms")}`,
};

export const GIMA_VIEWS: LocalView[] = [
  ACTIVITY,
  msView("spo2_sample", "GIMA_SPO2_SAMPLE", { spo2: "SPO2", type: "0" }, GIMA_VALID.spo2),
  msView("respiratory_rate_sample", "GIMA_RESPIRATORY_RATE_SAMPLE", { rate: "RESPIRATORY_RATE" }, GIMA_VALID.respiration),
  msView("hrv_value_sample", "GIMA_HRV_VALUE_SAMPLE", { value: "HRV", cvrr: "CVRR" }, GIMA_VALID.hrv),
  msView("blood_pressure_sample", "GIMA_BLOOD_PRESSURE_SAMPLE", { systolic: "BP_SYSTOLIC", diastolic: "BP_DIASTOLIC" }, GIMA_VALID.bloodPressure),
  msView("body_temperature_sample", "GIMA_BODY_TEMPERATURE_SAMPLE", { temperature: "TEMPERATURE" }, GIMA_VALID.temperature),
  SLEEP_STAGES,
  SLEEP_SESSIONS,
  ECG,
  // the same as Garmin's (db/queries.ts): Gima's distance is always measured, so no estimate is needed
  {
    name: "person_stride",
    time: "stride_cm",
    whole: true,
    select: () => `SELECT user_id,
      CASE WHEN SUM(steps > 0 AND distance_missing = 0) >= ${MIN_STRIDE_MINUTES / 30} AND SUM(CASE WHEN distance_missing = 0 THEN steps ELSE 0 END) >= ${MIN_STRIDE_STEPS}
        THEN SUM(COALESCE(distance_cm, 0)) * 1.0 / SUM(CASE WHEN distance_missing = 0 THEN steps ELSE 0 END) END AS stride_cm
      FROM activity_sample GROUP BY user_id`,
  },
  // what the Gima watches do not measure (brand.ts hides those sections in HeartBridge)
  ...(["stress_sample", "body_energy_sample", "resting_hr_sample", "intensity_minutes_sample", "resting_metabolic_rate_sample", "nap_sample", "hrv_summary_sample", "sleep_stats_sample", "live_sample", "sleep_restless_sample"] as const).map(
    (name) => emptyView(name, [...APP_COLUMNS[name]]),
  ),
];
