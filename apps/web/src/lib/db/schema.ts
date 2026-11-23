/**
 * SQLite schema. Modelled on Gadgetbridge's Garmin tables (GBDaoGenerator), but
 * with plain snake_case names and every timestamp in unix SECONDS.
 *
 * Every sample table carries both user_id (the patient) and device_id, so the
 * same schema works for a single local user and, later, for a multi-patient
 * database opened by a doctor.
 */
export const SCHEMA_VERSION = 7;

/** Tables whose rows carry both device_id and user_id (moved along with their device). */
const USER_TABLES = [
  "activity_sample", "stress_sample", "body_energy_sample", "spo2_sample", "respiratory_rate_sample", "resting_hr_sample",
  "sleep_stage_sample", "sleep_stats_sample", "sleep_restless_sample", "nap_sample", "hrv_summary_sample", "hrv_value_sample",
  "intensity_minutes_sample", "resting_metabolic_rate_sample", "workout", "live_sample", "sleep_session",
];

export const MIGRATIONS: string[] = [
  /* v1 */ `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    birthday TEXT,
    gender TEXT,
    height_cm REAL,
    weight_kg REAL,
    step_goal INTEGER DEFAULT 8000,
    sleep_goal_min INTEGER DEFAULT 480,
    active_minutes_goal INTEGER DEFAULT 150,
    distance_goal_m INTEGER DEFAULT 5000,
    calories_goal INTEGER DEFAULT 350,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS device (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES user(id),
    name TEXT NOT NULL,
    alias TEXT,
    model TEXT,
    ble_id TEXT,
    product_number INTEGER,
    unit_number TEXT,
    firmware TEXT,
    is_demo INTEGER NOT NULL DEFAULT 0,
    battery_level INTEGER,
    battery_ts INTEGER,
    last_sync INTEGER,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Raw FIT files as downloaded from the band (kept so data can be re-imported)
  CREATE TABLE IF NOT EXISTS fit_file (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    file_index INTEGER,
    data_type INTEGER NOT NULL,
    sub_type INTEGER NOT NULL,
    file_type TEXT,
    file_number INTEGER,
    file_size INTEGER NOT NULL,
    file_date INTEGER,
    downloaded_at INTEGER NOT NULL DEFAULT (unixepoch()),
    processed_at INTEGER,
    error TEXT,
    data BLOB NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS fit_file_identity ON fit_file(device_id, data_type, sub_type, file_number, file_date, file_size);

  -- Monitoring samples (like GarminActivitySample, usually one per minute).
  -- Unlike Gadgetbridge, cumulative counters are converted to per-sample deltas at import time,
  -- so daily totals are a simple SUM().
  CREATE TABLE IF NOT EXISTS activity_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    activity_type INTEGER,          -- Garmin activity_type: 0 generic, 1 running, 2 cycling, 6 walking, 8 sedentary...
    intensity INTEGER,              -- 0..7 from current_activity_type_intensity
    steps INTEGER NOT NULL DEFAULT 0,          -- steps in this sample (delta, not cumulative)
    heart_rate INTEGER,
    distance_cm INTEGER NOT NULL DEFAULT 0,    -- delta
    active_calories INTEGER NOT NULL DEFAULT 0, -- kcal, delta
    PRIMARY KEY (device_id, timestamp)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS stress_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL, stress INTEGER NOT NULL,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS body_energy_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL, energy INTEGER NOT NULL,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS spo2_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL, spo2 INTEGER NOT NULL, type INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS respiratory_rate_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL, rate REAL NOT NULL,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS resting_hr_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL, heart_rate INTEGER NOT NULL,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  -- stage: 0 unmeasurable, 1 awake, 2 light, 3 deep, 4 rem (FIT SleepLevel)
  CREATE TABLE IF NOT EXISTS sleep_stage_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL, stage INTEGER NOT NULL,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS sleep_stats_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    sleep_score INTEGER, awake_time_score INTEGER, awakenings_count INTEGER, awakenings_count_score INTEGER,
    deep_sleep_score INTEGER, light_sleep_score INTEGER, rem_sleep_score INTEGER, sleep_duration_score INTEGER,
    sleep_quality_score INTEGER, sleep_recovery_score INTEGER, sleep_restlessness_score INTEGER,
    interruptions_score INTEGER, average_stress_during_sleep REAL,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS sleep_restless_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL, count INTEGER NOT NULL,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS nap_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL, end_timestamp INTEGER NOT NULL,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  -- status: 0 none, 1 poor, 2 low, 3 unbalanced, 4 balanced
  CREATE TABLE IF NOT EXISTS hrv_summary_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    weekly_average INTEGER, last_night_average INTEGER, last_night_5min_high INTEGER,
    baseline_low_upper INTEGER, baseline_balanced_lower INTEGER, baseline_balanced_upper INTEGER, status INTEGER,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS hrv_value_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL, value INTEGER NOT NULL,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS intensity_minutes_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL, moderate INTEGER NOT NULL, vigorous INTEGER NOT NULL,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS resting_metabolic_rate_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL, rate INTEGER NOT NULL,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS battery_level (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    timestamp INTEGER NOT NULL, level INTEGER NOT NULL,
    PRIMARY KEY (device_id, timestamp)) WITHOUT ROWID;

  -- Recorded activities ("Attività sportive" in Gadgetbridge: BaseActivitySummary)
  CREATE TABLE IF NOT EXISTS workout (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    fit_file_id INTEGER REFERENCES fit_file(id) ON DELETE SET NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    sport INTEGER, sub_sport INTEGER, name TEXT,
    elapsed_s REAL, timer_s REAL, distance_m REAL, calories INTEGER,
    avg_hr INTEGER, max_hr INTEGER, ascent_m REAL, descent_m REAL, steps INTEGER, avg_speed REAL,
    summary TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workout_identity ON workout(device_id, start_time);

  CREATE TABLE IF NOT EXISTS workout_record (
    workout_id INTEGER NOT NULL REFERENCES workout(id) ON DELETE CASCADE,
    timestamp INTEGER NOT NULL,
    heart_rate INTEGER, lat REAL, lon REAL, altitude REAL, speed REAL, distance REAL, cadence INTEGER,
    PRIMARY KEY (workout_id, timestamp)) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS activity_user_ts ON activity_sample(user_id, timestamp);
  `,
  /* v2: values received on the band's live channels, aggregated per minute.
     They fill the gap between the last synced FIT data and "now"; once the FIT files
     cover a period, the live rows of that period are ignored (no double counting). */ `
  CREATE TABLE IF NOT EXISTS live_sample (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,     -- start of the minute
    heart_rate INTEGER,             -- average of the minute
    steps INTEGER NOT NULL DEFAULT 0, -- steps taken in this minute (delta of the band's day counter)
    body_battery INTEGER,
    respiration REAL,
    spo2 INTEGER,
    PRIMARY KEY (device_id, timestamp)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS live_user_ts ON live_sample(user_id, timestamp);
  `,
  /* v3: content fingerprint of every FIT file, to recognise the same file arriving twice
     (downloaded from the band and imported from a Gadgetbridge export, or imported twice).
     Rows from older versions are filled in lazily (backfillFitHashes). */ `
  ALTER TABLE fit_file ADD COLUMN sha256 TEXT;
  ALTER TABLE fit_file ADD COLUMN source TEXT NOT NULL DEFAULT 'band';
  CREATE INDEX IF NOT EXISTS fit_file_sha ON fit_file(sha256);
  `,
  /* v4: sleep start/end as written by the band (FIT event 74 "sleep", type 0 = start, 1 = end).
     Real Garmin bands store only the stage *changes*: each stage lasts until the next change,
     the night ends at the "sleep end" event. */ `
  CREATE TABLE IF NOT EXISTS sleep_session (
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
    start INTEGER NOT NULL, "end" INTEGER NOT NULL,
    PRIMARY KEY (device_id, start)) WITHOUT ROWID;
  `,
  /* v5: laps of an activity (FIT "lap" messages, e.g. auto-lap every km/mile) and the
     temperature of each track point. Activities imported before need "Rielabora file". */ `
  CREATE TABLE IF NOT EXISTS workout_lap (
    workout_id INTEGER NOT NULL REFERENCES workout(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    start_time INTEGER NOT NULL,
    elapsed_s REAL, timer_s REAL, distance_m REAL, calories INTEGER,
    avg_speed REAL, max_speed REAL, avg_hr INTEGER, max_hr INTEGER, avg_cadence REAL, max_cadence REAL,
    ascent_m REAL, descent_m REAL, lap_trigger INTEGER,
    PRIMARY KEY (workout_id, idx)) WITHOUT ROWID;
  ALTER TABLE workout_record ADD COLUMN temperature REAL;
  `,
  /* v6: the demo gets its own user, flagged is_demo, so simulated data never adds up with a real
     band's and never enters comparisons or uploads. Existing demo devices move there with all
     their rows. workout_lap is created again for databases that reached v5 without it (the
     startup schema check, checkSchema, repairs any other missing table or column). */ `
  ALTER TABLE user ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
  INSERT INTO user (name, is_demo) SELECT 'Demo', 1 WHERE EXISTS (SELECT 1 FROM device WHERE is_demo = 1);
  UPDATE device SET user_id = (SELECT MAX(id) FROM user WHERE is_demo = 1) WHERE is_demo = 1;
${USER_TABLES.map((t) => `  UPDATE ${t} SET user_id = (SELECT user_id FROM device WHERE device.id = ${t}.device_id) WHERE device_id IN (SELECT id FROM device WHERE is_demo = 1);`).join("\n")}
  CREATE TABLE IF NOT EXISTS workout_lap (
    workout_id INTEGER NOT NULL REFERENCES workout(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    start_time INTEGER NOT NULL,
    elapsed_s REAL, timer_s REAL, distance_m REAL, calories INTEGER,
    avg_speed REAL, max_speed REAL, avg_hr INTEGER, max_hr INTEGER, avg_cadence REAL, max_cadence REAL,
    ascent_m REAL, descent_m REAL, lap_trigger INTEGER,
    PRIMARY KEY (workout_id, idx)) WITHOUT ROWID;
  `,
  /* v7: the band's day counters now restart at the band's midnight (they were carried over to the
     next day, losing the first values of an activity type after midnight). Stored data is
     recomputed once from the kept FIT files at the next start (DeviceManager.runPendingReprocess). */ `
  INSERT OR REPLACE INTO meta (key, value) SELECT 'reprocess_pending', 'contatori azzerati alla mezzanotte del bracciale'
    WHERE EXISTS (SELECT 1 FROM fit_file);
  `,
];

/** Garmin FIT activity_type values seen in monitoring files */
export const ActivityType: Record<number, string> = {
  0: "Generico",
  1: "Corsa",
  2: "Ciclismo",
  3: "Transizione",
  4: "Attrezzi",
  5: "Nuoto",
  6: "Camminata",
  8: "Sedentario",
};

export const SleepStage = { UNMEASURABLE: 0, AWAKE: 1, LIGHT: 2, DEEP: 3, REM: 4 } as const;
