/**
 * Read-only views that show the research server's tables (Gadgetbridge format) with the names,
 * columns and units of the app's own schema, so that loadRange, the daily values and the
 * comparison rules run unchanged on server data: the same definitions for the app and the server.
 *
 * They are TEMP views: created on the connection, nothing is written to the server database.
 * Rows keep the server's USER_ID (the participant id) as user_id.
 *
 * The local day that splits the band's day counters comes from an explicit time zone (option
 * `timeZone`, by default the study's: Europe/Rome for every participant), never from the
 * server's own 'localtime': SQLite knows no time zones, so createLocalViews writes the zone's UTC
 * offsets (daylight saving included) into the TEMP table tz_offset. loadRange groups days with the
 * same zone (time-zone.ts), whatever the zone of the browser or of the process.
 */
import type { SqlExecutor } from "../db/sql";
import { STUDY_TIME_ZONE, zoneTransitions } from "../time-zone";
import { MIN_STRIDE_MINUTES, MIN_STRIDE_STEPS } from "../metrics";
import { ActivityKind, NOT_MEASURED } from "./schema";

/**
 * GARMIN_ACTIVITY_SAMPLE holds cumulative day counters (summed over activity types), -1 when not
 * measured, gap rows and NOT_WORN rows. The app's activity_sample holds per-minute values:
 *  - not worn rows are left out, -1 becomes NULL;
 *  - the value of a minute is the counter minus the previous measured counter of the same local
 *    day (the measured rows only, -1 rows skipped); the first measured value of a day is the counter itself
 *    (counters restart at midnight); a counter that goes down gives NULL and becomes the new base;
 *  - like the app's importer (and Gadgetbridge when it reads), the counter read at t covers the
 *    minute before it: rows move to t - 60, so the sample at midnight closes the previous day;
 *  - distance_missing = 1 when no measured DISTANCE_CM comes at or after the minute on the same
 *    day: its steps have no distance at all (Gadgetbridge often stores -1), and the queries add an
 *    estimate for them (db/queries.ts, person_stride). Distance the counter carries to a later
 *    measured minute is not missing: it is in that minute's delta.
 */
const COUNTERS = [
  ["STEPS", "steps"],
  ["DISTANCE_CM", "distance_cm"],
  ["ACTIVE_CALORIES", "active_calories"],
] as const;

// One sort, no joins. The counters are measured independently, so "the previous measured value"
// differs per column, and SQLite's LAG cannot skip -1 rows. Instead: the latest measured row before
// this one has the highest TIMESTAMP, so MAX(TIMESTAMP * 2^31 + value) over the earlier rows of the
// day packs it, and the value is the remainder (counters of a day stay far below 2^31, TIMESTAMP
// below 2^32 until 2106). Every window has the same partition and order: SQLite sorts once.
const PACK = 2147483648;
const ACTIVITY_VIEW: LocalView = { name: "activity_sample", select: (from) => `
SELECT DEVICE_ID AS device_id, USER_ID AS user_id, TIMESTAMP - 60 AS timestamp,
  NULL AS activity_type,
  NULLIF(RAW_INTENSITY, ${NOT_MEASURED}) AS intensity,
  ${COUNTERS.map(([c, ours]) => `CASE WHEN ${c} < 0 THEN NULL WHEN p_${c} IS NULL THEN ${c} WHEN ${c} >= p_${c} % ${PACK} THEN ${c} - p_${c} % ${PACK} END AS ${ours}`).join(", ")},
  NULLIF(HEART_RATE, ${NOT_MEASURED}) AS heart_rate,
  CASE WHEN last_distance IS NULL OR TIMESTAMP > last_distance THEN 1 ELSE 0 END AS distance_missing
FROM (
  SELECT *, ${COUNTERS.map(([c]) => `MAX(CASE WHEN ${c} >= 0 THEN TIMESTAMP * ${PACK} + ${c} END) OVER earlier AS p_${c}`).join(", ")},
    MAX(CASE WHEN DISTANCE_CM >= 0 THEN TIMESTAMP END) OVER whole AS last_distance
  FROM (
    SELECT USER_ID, DEVICE_ID, TIMESTAMP, RAW_INTENSITY, HEART_RATE, STEPS, DISTANCE_CM, ACTIVE_CALORIES,
      date(TIMESTAMP - 60 + (SELECT o FROM tz_offset WHERE t <= TIMESTAMP - 60 ORDER BY t DESC LIMIT 1), 'unixepoch') AS day
    FROM GARMIN_ACTIVITY_SAMPLE WHERE RAW_KIND <> ${ActivityKind.NOT_WORN}${from == null ? "" : ` AND TIMESTAMP - 60 >= ${from}`}
  )
  WINDOW earlier AS (PARTITION BY USER_ID, DEVICE_ID, day ORDER BY TIMESTAMP ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
    whole AS (PARTITION BY USER_ID, DEVICE_ID, day ORDER BY TIMESTAMP ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
)` };

/** A millisecond table shown as a seconds one: `cols` maps our column to the server expression. */
export const msView = (name: string, table: string, cols: Record<string, string>, where = ""): LocalView => ({
  name,
  select: (from) => {
    const conds = [where, from == null ? "" : `TIMESTAMP >= ${from * 1000}`].filter(Boolean);
    return `SELECT DEVICE_ID AS device_id, USER_ID AS user_id, TIMESTAMP / 1000 AS timestamp,
  ${Object.entries(cols).map(([ours, theirs]) => `${theirs} AS ${ours}`).join(", ")}
FROM ${table}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}`;
  },
});

/** A view with the app's columns and no rows (data the server format does not have). */
export const emptyView = (name: string, cols: string[]): LocalView => ({ name, select: () => `SELECT ${cols.map((c) => `NULL AS ${c}`).join(", ")} WHERE 0` });

const ids = ["device_id", "user_id", "timestamp"];
/**
 * The app's tables only one of the two apps has data for, with the same columns in both (the
 * queries run unchanged; a Garmin copy simply has no rows in them, a Gima copy none in Garmin's).
 */
export const APP_COLUMNS = {
  stress_sample: [...ids, "stress"],
  body_energy_sample: [...ids, "energy"],
  resting_hr_sample: [...ids, "heart_rate"],
  intensity_minutes_sample: [...ids, "moderate", "vigorous"],
  resting_metabolic_rate_sample: [...ids, "rate"],
  nap_sample: [...ids, "end_timestamp"],
  hrv_summary_sample: [...ids, "weekly_average", "last_night_average", "last_night_5min_high", "baseline_low_upper", "baseline_balanced_lower", "baseline_balanced_upper", "status"],
  sleep_stats_sample: [
    ...ids, "sleep_score", "awake_time_score", "awakenings_count", "awakenings_count_score", "deep_sleep_score", "light_sleep_score", "rem_sleep_score", "sleep_duration_score",
    "sleep_quality_score", "sleep_recovery_score", "sleep_restlessness_score", "interruptions_score", "average_stress_during_sleep",
  ],
  // HeartBridge (Gima): blood pressure, body temperature, ECG recordings (the samples stay in ECG_MEASUREMENTS)
  blood_pressure_sample: [...ids, "systolic", "diastolic"],
  body_temperature_sample: [...ids, "temperature"],
  ecg_recording: [...ids, "start_ms", "duration_s", "sample_count", "heart", "sbp", "dbp", "hrv", "is_afib", "diagnose_type", "ai_heart"],
  live_sample: [...ids, "heart_rate", "steps", "body_battery", "respiration", "spo2"],
  sleep_restless_sample: [...ids, "count"],
} as const;

/** One of the app's tables, as a SELECT over the server's tables. */
export interface LocalView {
  name: string;
  /**
   * the SELECT; with `from` (a day start of the study's zone, unix seconds) only the rows from that
   * day on, computed exactly as the full SELECT computes them (see updateLocalTables)
   */
  select: (from: number | null) => string;
  /** column the app's queries filter on besides user_id (for the index of a materialized copy) */
  time?: string;
  /** column whose value ≥ from marks the rows a partial update replaces (default: timestamp) */
  updatedBy?: string;
  /** an aggregate over other app tables: a partial update recomputes it in full, after them */
  whole?: boolean;
}

export const LOCAL_VIEWS: LocalView[] = [
  ACTIVITY_VIEW,
  msView("stress_sample", "GARMIN_STRESS_SAMPLE", { stress: "STRESS" }),
  // the app keeps only valid Body Battery values
  msView("body_energy_sample", "GARMIN_BODY_ENERGY_SAMPLE", { energy: "ENERGY" }, "ENERGY >= 0"),
  // Gadgetbridge numbers SpO2 types MANUAL 0, AUTOMATIC 1, UNKNOWN 2; the app 0 unknown, 1 manual, 2 automatic
  msView("spo2_sample", "GARMIN_SPO2_SAMPLE", { spo2: "SPO2", type: "CASE TYPE_NUM WHEN 0 THEN 1 WHEN 1 THEN 2 ELSE 0 END" }),
  msView("respiratory_rate_sample", "GARMIN_RESPIRATORY_RATE_SAMPLE", { rate: "RESPIRATORY_RATE" }),
  msView("resting_hr_sample", "GARMIN_HEART_RATE_RESTING_SAMPLE", { heart_rate: "HEART_RATE" }),
  msView("sleep_stage_sample", "GARMIN_SLEEP_STAGE_SAMPLE", { stage: "STAGE" }),
  msView("sleep_stats_sample", "GARMIN_SLEEP_STATS_SAMPLE", {
    sleep_score: "SLEEP_SCORE",
    ...Object.fromEntries(
      ["awake_time_score", "awakenings_count", "awakenings_count_score", "deep_sleep_score", "light_sleep_score", "rem_sleep_score", "sleep_duration_score",
        "sleep_quality_score", "sleep_recovery_score", "sleep_restlessness_score", "interruptions_score", "average_stress_during_sleep"].map((c) => [c, "NULL"]),
    ),
  }),
  msView("nap_sample", "GARMIN_NAP_SAMPLE", { end_timestamp: "END_TIMESTAMP / 1000" }),
  msView("hrv_summary_sample", "GARMIN_HRV_SUMMARY_SAMPLE", {
    weekly_average: "WEEKLY_AVERAGE",
    last_night_average: "LAST_NIGHT_AVERAGE",
    last_night_5min_high: "LAST_NIGHT5_MIN_HIGH",
    baseline_low_upper: "BASELINE_LOW_UPPER",
    baseline_balanced_lower: "BASELINE_BALANCED_LOWER",
    baseline_balanced_upper: "BASELINE_BALANCED_UPPER",
    status: "STATUS_NUM",
  }),
  // CVRR: Gima only
  msView("hrv_value_sample", "GARMIN_HRV_VALUE_SAMPLE", { value: "VALUE", cvrr: "NULL" }),
  msView("intensity_minutes_sample", "GARMIN_INTENSITY_MINUTES_SAMPLE", { moderate: "COALESCE(MODERATE, 0)", vigorous: "COALESCE(VIGOROUS, 0)" }),
  msView("resting_metabolic_rate_sample", "GARMIN_RESTING_METABOLIC_RATE_SAMPLE", { rate: "RESTING_METABOLIC_RATE" }),
  // nights from the band's sleep events (74: type 0 start, type 1 end), like the app's importer;
  // an end is paired with the latest start in the 24 hours before it
  {
    name: "sleep_session",
    time: "start",
    // a night belongs to the day it ends; nights ending from `from` on are recomputed
    updatedBy: '"end"',
    select: (from) => `SELECT device_id, user_id, start, "end" FROM (
     SELECT e.DEVICE_ID AS device_id, e.USER_ID AS user_id, e.TIMESTAMP / 1000 AS "end",
       (SELECT MAX(s.TIMESTAMP) / 1000 FROM GARMIN_EVENT_SAMPLE s
        WHERE s.USER_ID = e.USER_ID AND s.DEVICE_ID = e.DEVICE_ID AND s.EVENT = 74 AND s.EVENT_TYPE = 0
          AND s.TIMESTAMP < e.TIMESTAMP AND s.TIMESTAMP > e.TIMESTAMP - 86400000) AS start
     FROM GARMIN_EVENT_SAMPLE e WHERE e.EVENT = 74 AND e.EVENT_TYPE = 1
   ) WHERE start IS NOT NULL${from == null ? "" : ` AND "end" >= ${from}`}`,
  },
  // each person's average step length (cm) from the minutes whose steps are covered by measured
  // distance; NULL with too few of them (the queries then use DEFAULT_STRIDE_CM). Aggregate over
  // all the person's days: always recomputed in full.
  {
    name: "person_stride",
    time: "stride_cm",
    whole: true,
    select: () => `SELECT user_id,
      CASE WHEN SUM(steps > 0 AND distance_missing = 0) >= ${MIN_STRIDE_MINUTES} AND SUM(CASE WHEN distance_missing = 0 THEN steps ELSE 0 END) >= ${MIN_STRIDE_STEPS}
        THEN SUM(COALESCE(distance_cm, 0)) * 1.0 / SUM(CASE WHEN distance_missing = 0 THEN steps ELSE 0 END) END AS stride_cm
      FROM activity_sample GROUP BY user_id`,
  },
  // not in the server format: the app's live minutes and restless moments
  emptyView("live_sample", [...APP_COLUMNS.live_sample]),
  emptyView("sleep_restless_sample", [...APP_COLUMNS.sleep_restless_sample]),
  // HeartBridge's own data: not measured by the Garmin bands
  emptyView("blood_pressure_sample", [...APP_COLUMNS.blood_pressure_sample]),
  emptyView("body_temperature_sample", [...APP_COLUMNS.body_temperature_sample]),
  emptyView("ecg_recording", [...APP_COLUMNS.ecg_recording]),
];

/**
 * Creates the app's tables on a connection to a server database: as views (always current, but
 * every query recomputes them over all participants), or materialized as TEMP tables with an
 * index on (user_id, time), a snapshot to rebuild (call again) after new data is uploaded. Both
 * are idempotent and never write to the server's own tables.
 */
/** the zone's UTC offsets for the views (TEMP: per connection, nothing written to the database) */
async function createTzOffsets(db: SqlExecutor, timeZone: string) {
  await db.run("DROP TABLE IF EXISTS temp.tz_offset");
  await db.run("CREATE TEMP TABLE tz_offset (t INTEGER PRIMARY KEY, o INTEGER NOT NULL) WITHOUT ROWID");
  await db.batch(zoneTransitions(timeZone).map(([t, o]) => ({ sql: "INSERT INTO temp.tz_offset VALUES (?, ?)", params: [t, o] })));
}

export const createLocalViews = (db: SqlExecutor, opts: { materialize?: boolean; timeZone?: string } = {}) => createViews(db, LOCAL_VIEWS, opts);

/** createLocalViews for any list of views (Garmin's LOCAL_VIEWS, Gima's GIMA_VIEWS) */
export async function createViews(db: SqlExecutor, views: LocalView[], opts: { materialize?: boolean; timeZone?: string } = {}) {
  await createTzOffsets(db, opts.timeZone ?? STUDY_TIME_ZONE);
  const existing = await db.all<{ name: string; type: string }>("SELECT name, type FROM sqlite_temp_master WHERE type IN ('view', 'table') AND name <> 'tz_offset'");
  for (const v of views) {
    const old = existing.find((e) => e.name === v.name);
    if (old) await db.run(`DROP ${old.type === "view" ? "VIEW" : "TABLE"} temp.${v.name}`);
    if (!opts.materialize) await db.run(`CREATE TEMP VIEW ${v.name} AS ${v.select(null)}`);
    else {
      await db.run(`CREATE TEMP TABLE ${v.name} AS ${v.select(null)}`);
      await db.run(`CREATE INDEX temp.${v.name}_user_time ON ${v.name} (user_id, ${v.time ?? "timestamp"})`);
    }
  }
}

/**
 * The app's tables as ordinary (persistent) tables of the database: for the browser's copy, which
 * keeps them between visits instead of rebuilding them at every start. With `from` (a day start of
 * the study's zone) only the rows from that day on are replaced, in one transaction per table: the
 * views compute whole days (the day counters restart at local midnight), so the result is the same
 * as a full rebuild. Without `from`, or when a table is missing, everything is rebuilt.
 * Never on a research server database (it only ever gets TEMP views or tables).
 */
export const updateLocalTables = (db: SqlExecutor, opts: { from: number | null; timeZone?: string }) => updateTables(db, LOCAL_VIEWS, opts);

/** updateLocalTables for any list of views */
export async function updateTables(db: SqlExecutor, views: LocalView[], opts: { from: number | null; timeZone?: string }): Promise<"full" | "partial"> {
  await createTzOffsets(db, opts.timeZone ?? STUDY_TIME_ZONE);
  const existing = new Set((await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
  const full = opts.from == null || views.some((v) => !existing.has(v.name));
  for (const v of views) {
    if (full)
      await db.batch([
        { sql: `DROP TABLE IF EXISTS main.${v.name}` },
        { sql: `CREATE TABLE main.${v.name} AS ${v.select(null)}` },
        { sql: `CREATE INDEX main.${v.name}_user_time ON ${v.name} (user_id, ${v.time ?? "timestamp"})` },
      ]);
    else if (v.whole) await db.batch([{ sql: `DELETE FROM main.${v.name}` }, { sql: `INSERT INTO main.${v.name} SELECT * FROM (${v.select(null)})` }]);
    else
      await db.batch([
        { sql: `DELETE FROM main.${v.name} WHERE ${v.updatedBy ?? "timestamp"} >= ?`, params: [opts.from] },
        { sql: `INSERT INTO main.${v.name} SELECT * FROM (${v.select(opts.from)})` },
      ]);
  }
  return full ? "full" : "partial";
}
