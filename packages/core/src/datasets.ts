/**
 * The two apps and the research server database each one reads: its schema, the tables a valid
 * copy must have, the health tables a participant may download (only their own rows) and the
 * device columns that may be shown. The single place that lists them: the server's data access,
 * the copy check and the synthetic generator all read from here.
 */
import { GIMA_SCHEMA } from "./gima/schema";
import { SERVER_SCHEMA } from "./server/schema";

export const APPS = ["vitabridge", "heartbridge"] as const;
export type AppId = (typeof APPS)[number];

export const isAppId = (v: unknown): v is AppId => typeof v === "string" && (APPS as readonly string[]).includes(v);

/** A health table: one row per sample, USER_ID = participant.id, DEVICE_ID = device.id. */
export interface DataTable {
  name: string;
  /** column with the sample's time */
  time: string;
  /** unit of the time column */
  unit: "s" | "ms";
}

export interface Dataset {
  app: AppId;
  /** the app's name shown to people */
  label: string;
  /** the server database's schema (CREATE TABLE IF NOT EXISTS ...) */
  schema: string;
  /** every table a copy of the server database must have to be used */
  requiredTables: string[];
  /** the health tables a participant downloads, in this order */
  dataTables: DataTable[];
  /**
   * device columns shown to the participant and to the administrator: never `identifier` (serial
   * number or MAC address) or `hardware_id`
   */
  deviceColumns: string[];
}

/** Table names created by a schema, in order. */
export const tablesOf = (schema: string) => [...schema.matchAll(/CREATE TABLE IF NOT EXISTS "?(\w+)"?/g)].map((m) => m[1]);

const ms = (name: string, time = "TIMESTAMP"): DataTable => ({ name, time, unit: "ms" });

export const DATASETS: Record<AppId, Dataset> = {
  vitabridge: {
    app: "vitabridge",
    label: "VitaBridge",
    schema: SERVER_SCHEMA,
    requiredTables: tablesOf(SERVER_SCHEMA),
    // BASE_ACTIVITY_SUMMARY is left out: no participant has workouts and the app has no page for them
    dataTables: [
      { name: "GARMIN_ACTIVITY_SAMPLE", time: "TIMESTAMP", unit: "s" },
      { name: "BATTERY_LEVEL", time: "TIMESTAMP", unit: "s" },
      ms("GARMIN_STRESS_SAMPLE"),
      ms("GARMIN_BODY_ENERGY_SAMPLE"),
      ms("GARMIN_EVENT_SAMPLE"),
      ms("GARMIN_HEART_RATE_RESTING_SAMPLE"),
      ms("GARMIN_HRV_SUMMARY_SAMPLE"),
      ms("GARMIN_HRV_VALUE_SAMPLE"),
      ms("GARMIN_INTENSITY_MINUTES_SAMPLE"),
      ms("GARMIN_NAP_SAMPLE"),
      ms("GARMIN_RESPIRATORY_RATE_SAMPLE"),
      ms("GARMIN_RESTING_METABOLIC_RATE_SAMPLE"),
      ms("GARMIN_SLEEP_STAGE_SAMPLE"),
      ms("GARMIN_SLEEP_STATS_SAMPLE"),
      ms("GARMIN_SPO2_SAMPLE"),
    ],
    deviceColumns: ["id", "name", "manufacturer", "type_name", "model", "last_measurement_at", "last_successful_upload_at"],
  },
  heartbridge: {
    app: "heartbridge",
    label: "HeartBridge",
    schema: GIMA_SCHEMA,
    requiredTables: tablesOf(GIMA_SCHEMA),
    dataTables: [
      ms("GIMA_ACTIVITY_SAMPLE"),
      ms("GIMA_HEART_RATE_SAMPLE"),
      ms("GIMA_BLOOD_PRESSURE_SAMPLE"),
      ms("GIMA_SPO2_SAMPLE"),
      ms("GIMA_RESPIRATORY_RATE_SAMPLE"),
      ms("GIMA_BODY_TEMPERATURE_SAMPLE"),
      ms("GIMA_HRV_VALUE_SAMPLE"),
      ms("GIMA_SLEEP_STAGE_SAMPLE"),
      ms("GIMA_SLEEP_STATS_SAMPLE"),
      ms("ECG_MEASUREMENTS", "start_measure_ms"),
    ],
    deviceColumns: ["id", "name", "firmware_version", "last_measurement_at", "last_successful_upload_at"],
  },
};
