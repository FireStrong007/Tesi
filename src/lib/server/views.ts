/**
 * Read-only views that show the research server's tables (Gadgetbridge format) with the names,
 * columns and units of the app's own schema, so that loadRange, the daily values and the
 * comparison rules run unchanged on server data: the same definitions for the app and the server.
 *
 * They are TEMP views: created on the connection, nothing is written to the server database.
 * Rows keep the server's USER_ID (the participant id) as user_id.
 *
 * The local day that splits the band's day counters comes from an explicit time zone (option
 * `timeZone`, today Europe/Rome for every participant, waiting for the professor's answer), never
 * from the server's own 'localtime': SQLite knows no time zones, so createLocalViews writes the
 * zone's UTC offsets (daylight saving included) into the TEMP table tz_offset.
 * Note: loadRange groups days with the time zone of the process that runs it (the browser in the
 * app; on a server run Node with TZ set to the same zone).
 */
import type { SqlExecutor } from "../db/sql";
import { ActivityKind, NOT_MEASURED } from "./schema";

/**
 * GARMIN_ACTIVITY_SAMPLE holds cumulative day counters (summed over activity types), -1 when not
 * measured, gap rows and NOT_WORN rows. The app's activity_sample holds per-minute values:
 *  - not worn rows are left out, -1 becomes NULL;
 *  - the value of a minute is the counter minus the previous measured counter of the same local
 *    day (LAG over the measured rows only); the first measured value of a day is the counter itself
 *    (counters restart at midnight); a counter that goes down gives NULL and becomes the new base;
 *  - like the app's importer (and Gadgetbridge when it reads), the counter read at t covers the
 *    minute before it: rows move to t - 60, so the sample at midnight closes the previous day.
 */
const COUNTERS = [
  ["STEPS", "steps"],
  ["DISTANCE_CM", "distance_cm"],
  ["ACTIVE_CALORIES", "active_calories"],
] as const;

// One pass, no joins (the counters are measured independently, so "the previous measured value"
// differs per column). SQLite's LAG cannot skip -1 rows, hence: g = running count of measured
// values (each measured row starts a group), v = the measured value of the row's group, and the
// previous measured value of a measured row is v of the row just before it (group g - 1).
const ACTIVITY_VIEW: LocalView = { name: "activity_sample", select: `
SELECT DEVICE_ID AS device_id, USER_ID AS user_id, TIMESTAMP - 60 AS timestamp,
  NULL AS activity_type,
  NULLIF(RAW_INTENSITY, ${NOT_MEASURED}) AS intensity,
  ${COUNTERS.map(([c, ours]) => `CASE WHEN ${c} < 0 THEN NULL WHEN p_${c} IS NULL THEN ${c} WHEN ${c} >= p_${c} THEN ${c} - p_${c} END AS ${ours}`).join(", ")},
  NULLIF(HEART_RATE, ${NOT_MEASURED}) AS heart_rate
FROM (
  SELECT *, ${COUNTERS.map(([c]) => `LAG(v_${c}) OVER w AS p_${c}`).join(", ")}
  FROM (
    SELECT *, ${COUNTERS.map(([c]) => `MAX(CASE WHEN ${c} >= 0 THEN ${c} END) OVER (PARTITION BY USER_ID, DEVICE_ID, day, g_${c}) AS v_${c}`).join(", ")}
    FROM (
      SELECT *, ${COUNTERS.map(([c]) => `SUM(${c} >= 0) OVER w AS g_${c}`).join(", ")}
      FROM (
        SELECT USER_ID, DEVICE_ID, TIMESTAMP, RAW_INTENSITY, HEART_RATE, STEPS, DISTANCE_CM, ACTIVE_CALORIES,
          date(TIMESTAMP - 60 + (SELECT o FROM tz_offset WHERE t <= TIMESTAMP - 60 ORDER BY t DESC LIMIT 1), 'unixepoch') AS day
        FROM GARMIN_ACTIVITY_SAMPLE WHERE RAW_KIND <> ${ActivityKind.NOT_WORN}
      )
      WINDOW w AS (PARTITION BY USER_ID, DEVICE_ID, day ORDER BY TIMESTAMP ROWS UNBOUNDED PRECEDING)
    )
  )
  WINDOW w AS (PARTITION BY USER_ID, DEVICE_ID, day ORDER BY TIMESTAMP)
)` };

/** A millisecond table shown as a seconds one: `cols` maps our column to the server expression. */
const msView = (name: string, table: string, cols: Record<string, string>, where = ""): LocalView => ({
  name,
  select: `SELECT DEVICE_ID AS device_id, USER_ID AS user_id, TIMESTAMP / 1000 AS timestamp,
  ${Object.entries(cols).map(([ours, theirs]) => `${theirs} AS ${ours}`).join(", ")}
FROM ${table}${where ? ` WHERE ${where}` : ""}`,
});

/** A view with the app's columns and no rows (data the server format does not have). */
const emptyView = (name: string, cols: string[]): LocalView => ({ name, select: `SELECT ${cols.map((c) => `NULL AS ${c}`).join(", ")} WHERE 0` });

/** One of the app's tables, as a SELECT over the server's tables. */
export interface LocalView {
  name: string;
  select: string;
  /** column the app's queries filter on besides user_id (for the index of a materialized copy) */
  time?: string;
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
  msView("hrv_value_sample", "GARMIN_HRV_VALUE_SAMPLE", { value: "VALUE" }),
  msView("intensity_minutes_sample", "GARMIN_INTENSITY_MINUTES_SAMPLE", { moderate: "COALESCE(MODERATE, 0)", vigorous: "COALESCE(VIGOROUS, 0)" }),
  msView("resting_metabolic_rate_sample", "GARMIN_RESTING_METABOLIC_RATE_SAMPLE", { rate: "RESTING_METABOLIC_RATE" }),
  // nights from the band's sleep events (74: type 0 start, type 1 end), like the app's importer;
  // an end is paired with the latest start in the 24 hours before it
  {
    name: "sleep_session",
    time: "start",
    select: `SELECT device_id, user_id, start, "end" FROM (
     SELECT e.DEVICE_ID AS device_id, e.USER_ID AS user_id, e.TIMESTAMP / 1000 AS "end",
       (SELECT MAX(s.TIMESTAMP) / 1000 FROM GARMIN_EVENT_SAMPLE s
        WHERE s.USER_ID = e.USER_ID AND s.DEVICE_ID = e.DEVICE_ID AND s.EVENT = 74 AND s.EVENT_TYPE = 0
          AND s.TIMESTAMP < e.TIMESTAMP AND s.TIMESTAMP > e.TIMESTAMP - 86400000) AS start
     FROM GARMIN_EVENT_SAMPLE e WHERE e.EVENT = 74 AND e.EVENT_TYPE = 1
   ) WHERE start IS NOT NULL`,
  },
  // not in the server format: the app's live minutes and restless moments
  emptyView("live_sample", ["device_id", "user_id", "timestamp", "heart_rate", "steps", "body_battery", "respiration", "spo2"]),
  emptyView("sleep_restless_sample", ["device_id", "user_id", "timestamp", "count"]),
];

/**
 * Creates the app's tables on a connection to a server database: as views (always current, but
 * every query recomputes them over all participants), or materialized as TEMP tables with an
 * index on (user_id, time), a snapshot to rebuild (call again) after new data is uploaded. Both
 * are idempotent and never write to the server's own tables.
 */
export const DEFAULT_TIME_ZONE = "Europe/Rome";

/** UTC offset (seconds) of a time zone at a moment. */
export function zoneOffset(timeZone: string, ts: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(ts * 1000))
    .reduce<Record<string, number>>((o, p) => (p.type === "literal" ? o : { ...o, [p.type]: Number(p.value) }), {});
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000 - ts;
}

/** The zone's offset changes between two years: [from, offset] with the offset valid from that moment. */
export function zoneTransitions(timeZone: string, fromYear = 2015, toYear = 2045): [number, number][] {
  const start = Date.UTC(fromYear, 0, 1) / 1000;
  const end = Date.UTC(toYear, 0, 1) / 1000;
  const out: [number, number][] = [[start, zoneOffset(timeZone, start)]];
  for (let t = start + 86400; t <= end; t += 86400) {
    const o = zoneOffset(timeZone, t);
    if (o === out[out.length - 1][1]) continue;
    // the change happened within the last day: find the hour
    let lo = t - 86400;
    let hi = t;
    while (hi - lo > 60) {
      const mid = Math.floor((lo + hi) / 120) * 60;
      if (zoneOffset(timeZone, mid) === o) hi = mid;
      else lo = mid;
    }
    out.push([hi, o]);
  }
  return out;
}

export async function createLocalViews(db: SqlExecutor, opts: { materialize?: boolean; timeZone?: string } = {}) {
  await db.run("DROP TABLE IF EXISTS temp.tz_offset");
  await db.run("CREATE TEMP TABLE tz_offset (t INTEGER PRIMARY KEY, o INTEGER NOT NULL) WITHOUT ROWID");
  await db.batch(zoneTransitions(opts.timeZone ?? DEFAULT_TIME_ZONE).map(([t, o]) => ({ sql: "INSERT INTO temp.tz_offset VALUES (?, ?)", params: [t, o] })));
  const existing = await db.all<{ name: string; type: string }>("SELECT name, type FROM sqlite_temp_master WHERE type IN ('view', 'table') AND name <> 'tz_offset'");
  for (const v of LOCAL_VIEWS) {
    const old = existing.find((e) => e.name === v.name);
    if (old) await db.run(`DROP ${old.type === "view" ? "VIEW" : "TABLE"} temp.${v.name}`);
    if (!opts.materialize) await db.run(`CREATE TEMP VIEW ${v.name} AS ${v.select}`);
    else {
      await db.run(`CREATE TEMP TABLE ${v.name} AS ${v.select}`);
      await db.run(`CREATE INDEX temp.${v.name}_user_time ON ${v.name} (user_id, ${v.time ?? "timestamp"})`);
    }
  }
}
