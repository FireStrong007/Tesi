/**
 * Data access used by the UI. All functions take a SqlExecutor so they work with
 * the local OPFS database and, later, with a read-only multi-patient database.
 */
import type { DirectoryEntry } from "../garmin/gfdi";
import { fileTypeOf } from "../garmin/filetypes";
import { one, type SqlExecutor } from "@bridge/core/db/sql";

export interface User {
  id: number;
  name: string;
  birthday: string | null;
  gender: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  step_goal: number;
  sleep_goal_min: number;
  active_minutes_goal: number;
  distance_goal_m: number;
  calories_goal: number;
  /** 1 = the demo profile: simulated data, never compared with others nor sent anywhere */
  is_demo: number;
}

export interface DeviceSettings {
  keepOnDevice?: boolean;
  fetchUnknownFiles?: boolean;
  capabilityProfile?: "gadgetbridge" | "minimal";
  maxWriteSize?: number;
  syncTimeOnConnect?: boolean;
  autoSyncOnConnect?: boolean;
  /** open the band's live channels as soon as it connects (live Home) */
  liveOnConnect?: boolean;
  /** also open the live SpO2 channel (uses more battery) */
  liveSpo2?: boolean;
  /** automatic sync every N minutes while connected (0 = off) */
  autoSyncMinutes?: number;
  paired?: boolean;
}

export interface Device {
  id: number;
  user_id: number;
  name: string;
  alias: string | null;
  model: string | null;
  ble_id: string | null;
  product_number: number | null;
  unit_number: string | null;
  firmware: string | null;
  is_demo: number;
  battery_level: number | null;
  battery_ts: number | null;
  last_sync: number | null;
  settings: DeviceSettings;
  created_at: number;
}

const parseDevice = (r: Record<string, unknown>): Device => ({
  ...(r as unknown as Device),
  settings: JSON.parse((r.settings as string) || "{}"),
});

// ------------------------------------------------------------------ users

/** The first real (non-demo) user, created on first use. */
export async function ensureDefaultUser(db: SqlExecutor): Promise<User> {
  const u = await one<User>(db, "SELECT * FROM user WHERE is_demo = 0 ORDER BY id LIMIT 1");
  if (u) return u;
  await db.run("INSERT INTO user (name) VALUES (?)", ["Io"]);
  return (await one<User>(db, "SELECT * FROM user WHERE is_demo = 0 ORDER BY id LIMIT 1"))!;
}

/** The demo profile, created on first use: simulated bands live only here. */
export async function ensureDemoUser(db: SqlExecutor): Promise<User> {
  const u = await one<User>(db, "SELECT * FROM user WHERE is_demo = 1 ORDER BY id LIMIT 1");
  if (u) return u;
  await db.run("INSERT INTO user (name, is_demo) VALUES (?, 1)", ["Demo"]);
  return (await one<User>(db, "SELECT * FROM user WHERE is_demo = 1 ORDER BY id LIMIT 1"))!;
}

export async function getUser(db: SqlExecutor, id: number): Promise<User | undefined> {
  return one<User>(db, "SELECT * FROM user WHERE id = ?", [id]);
}

/** The profile shown by the app (remembered in the database); falls back to the default real user. */
export async function activeUser(db: SqlExecutor): Promise<User> {
  const id = Number((await one<{ value: string }>(db, "SELECT value FROM meta WHERE key = 'active_user'"))?.value);
  return (id ? await getUser(db, id) : undefined) ?? ensureDefaultUser(db);
}

export async function setActiveUser(db: SqlExecutor, id: number) {
  await db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('active_user', ?)", [String(id)]);
}

export async function listUsers(db: SqlExecutor): Promise<User[]> {
  return db.all<User>("SELECT * FROM user ORDER BY name");
}

/**
 * Users whose data may contribute to comparisons with other people and, later, be sent to the
 * server: never the demo profile. Every such path must go through this filter.
 */
export async function shareableUsers(db: SqlExecutor): Promise<User[]> {
  return db.all<User>("SELECT * FROM user WHERE is_demo = 0 ORDER BY id");
}

export async function updateUser(db: SqlExecutor, id: number, patch: Partial<Omit<User, "id">>) {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  await db.run(`UPDATE user SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
    ...keys.map((k) => (patch[k] ?? null) as string | number | null),
    id,
  ]);
}

// ------------------------------------------------------------------ devices

export async function listDevices(db: SqlExecutor, userId?: number): Promise<Device[]> {
  const rows = userId
    ? await db.all("SELECT * FROM device WHERE user_id = ? ORDER BY id", [userId])
    : await db.all("SELECT * FROM device ORDER BY id");
  return rows.map(parseDevice);
}

export async function getDevice(db: SqlExecutor, id: number): Promise<Device | undefined> {
  const r = await one(db, "SELECT * FROM device WHERE id = ?", [id]);
  return r ? parseDevice(r) : undefined;
}

export async function findDeviceByBleId(db: SqlExecutor, bleId: string): Promise<Device | undefined> {
  const r = await one(db, "SELECT * FROM device WHERE ble_id = ?", [bleId]);
  return r ? parseDevice(r) : undefined;
}

export async function addDevice(
  db: SqlExecutor,
  d: { user_id: number; name: string; model?: string; ble_id?: string; is_demo?: boolean; settings?: DeviceSettings },
): Promise<Device> {
  // simulated and real data never share a profile (they would add up in every chart)
  const owner = await getUser(db, d.user_id);
  if (!owner) throw new Error(`Utente ${d.user_id} inesistente`);
  if (!!owner.is_demo !== !!d.is_demo)
    throw new Error(d.is_demo ? "Un bracciale demo può stare solo nel profilo Demo" : "Nel profilo Demo non si possono aggiungere bracciali reali");
  const res = await db.run("INSERT INTO device (user_id, name, model, ble_id, is_demo, settings) VALUES (?,?,?,?,?,?)", [
    d.user_id, d.name, d.model ?? null, d.ble_id ?? null, d.is_demo ? 1 : 0, JSON.stringify(d.settings ?? {}),
  ]);
  return (await getDevice(db, res.lastInsertRowid))!;
}

export async function updateDevice(db: SqlExecutor, id: number, patch: Partial<Omit<Device, "id" | "settings">> & { settings?: DeviceSettings }) {
  const entries = Object.entries(patch).map(([k, v]) => [k, k === "settings" ? JSON.stringify(v) : v] as const);
  if (!entries.length) return;
  await db.run(`UPDATE device SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, [
    ...entries.map(([, v]) => (v ?? null) as string | number | null),
    id,
  ]);
}

export async function deleteDevice(db: SqlExecutor, id: number, deleteData: boolean) {
  if (!deleteData) {
    // keep samples: only forget the BLE binding
    await updateDevice(db, id, { ble_id: null });
    return;
  }
  await db.batch([
    { sql: "DELETE FROM meta WHERE key = ?", params: [`monitoring_state:${id}`] },
    { sql: "DELETE FROM device WHERE id = ?", params: [id] },
  ]);
}

export async function recordBattery(db: SqlExecutor, deviceId: number, level: number) {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    { sql: "UPDATE device SET battery_level = ?, battery_ts = ? WHERE id = ?", params: [level, now, deviceId] },
    { sql: "INSERT OR REPLACE INTO battery_level VALUES (?,?,?)", params: [deviceId, now, level] },
  ]);
}

// ------------------------------------------------------------------ fit files

export async function fitFileExists(db: SqlExecutor, deviceId: number, e: DirectoryEntry): Promise<boolean> {
  const r = await one(
    db,
    "SELECT id FROM fit_file WHERE device_id=? AND data_type=? AND sub_type=? AND file_number=? AND file_date IS ? AND file_size=?",
    [deviceId, e.fileDataType, e.fileSubType, e.fileNumber, e.fileDate, e.fileSize],
  );
  return !!r;
}

/** SHA-256 of a file's bytes, hex encoded (Web Crypto: available in browsers and Node). */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data.slice()));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Computes the fingerprint of FIT files stored before schema v3. */
export async function backfillFitHashes(db: SqlExecutor) {
  const rows = await db.all<{ id: number }>("SELECT id FROM fit_file WHERE sha256 IS NULL");
  for (const { id } of rows) {
    const r = (await db.all<{ data: Uint8Array }>("SELECT data FROM fit_file WHERE id = ?", [id]))[0];
    if (r) await db.run("UPDATE fit_file SET sha256 = ? WHERE id = ?", [await sha256Hex(r.data), id]);
  }
}

/** Id of a stored FIT file with the same content for this user's devices, if any. */
export async function findFitByHash(db: SqlExecutor, userId: number, sha: string): Promise<number | undefined> {
  const r = await one<{ id: number }>(
    db,
    "SELECT f.id FROM fit_file f JOIN device d ON d.id = f.device_id WHERE f.sha256 = ? AND d.user_id = ? LIMIT 1",
    [sha, userId],
  );
  return r?.id;
}

/**
 * Stores a FIT file. If the same content is already stored for this user (e.g. it was imported from
 * Gadgetbridge before), nothing is added and the existing id is returned with duplicate = true.
 */
export async function storeFitFile(
  db: SqlExecutor,
  deviceId: number,
  e: DirectoryEntry,
  data: Uint8Array,
  source: "band" | "gadgetbridge" | "file" = "band",
): Promise<{ id: number; duplicate: boolean }> {
  const sha = await sha256Hex(data);
  const owner = await one<{ user_id: number }>(db, "SELECT user_id FROM device WHERE id = ?", [deviceId]);
  if (owner) {
    await backfillFitHashes(db);
    const existing = await findFitByHash(db, owner.user_id, sha);
    if (existing !== undefined) return { id: existing, duplicate: true };
  }
  const res = await db.run(
    `INSERT OR REPLACE INTO fit_file (device_id, file_index, data_type, sub_type, file_type, file_number, file_size, file_date, data, sha256, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [deviceId, e.fileIndex, e.fileDataType, e.fileSubType, fileTypeOf(e.fileDataType, e.fileSubType)?.name ?? null, e.fileNumber, e.fileSize, e.fileDate, data, sha, source],
  );
  return { id: res.lastInsertRowid, duplicate: false };
}

export async function insertFitFile(db: SqlExecutor, deviceId: number, e: DirectoryEntry, data: Uint8Array): Promise<number> {
  return (await storeFitFile(db, deviceId, e, data)).id;
}

export async function markFitProcessed(db: SqlExecutor, id: number, error: string | null) {
  await db.run("UPDATE fit_file SET processed_at = unixepoch(), error = ? WHERE id = ?", [error, id]);
}

export interface FitFileRow {
  id: number;
  file_type: string | null;
  file_size: number;
  file_date: number | null;
  downloaded_at: number;
  processed_at: number | null;
  error: string | null;
}

export async function listFitFiles(db: SqlExecutor, deviceId?: number): Promise<FitFileRow[]> {
  return deviceId
    ? db.all("SELECT id,file_type,file_size,file_date,downloaded_at,processed_at,error FROM fit_file WHERE device_id=? ORDER BY file_date DESC", [deviceId])
    : db.all("SELECT id,file_type,file_size,file_date,downloaded_at,processed_at,error FROM fit_file ORDER BY file_date DESC");
}

export async function getFitFileData(db: SqlExecutor, id: number): Promise<{ data: Uint8Array; device_id: number; user_id: number } | undefined> {
  return one(db, "SELECT f.data, f.device_id, d.user_id FROM fit_file f JOIN device d ON d.id = f.device_id WHERE f.id = ?", [id]);
}

// ------------------------------------------------------------------ data queries (shared with the server)

export * from "@bridge/core/db/queries";

// ------------------------------------------------------------------ workouts

export interface Workout {
  id: number;
  device_id: number;
  start_time: number;
  end_time: number;
  sport: number | null;
  sub_sport: number | null;
  name: string | null;
  elapsed_s: number | null;
  timer_s: number | null;
  distance_m: number | null;
  calories: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  ascent_m: number | null;
  descent_m: number | null;
  steps: number | null;
  avg_speed: number | null;
  summary: string;
}

export async function listWorkouts(db: SqlExecutor, userId: number, limit = 200): Promise<Workout[]> {
  return db.all("SELECT * FROM workout WHERE user_id = ? ORDER BY start_time DESC LIMIT ?", [userId, limit]);
}

export async function getWorkout(db: SqlExecutor, id: number): Promise<Workout | undefined> {
  return one(db, "SELECT * FROM workout WHERE id = ?", [id]);
}

export interface WorkoutRecord {
  timestamp: number;
  heart_rate: number | null;
  lat: number | null;
  lon: number | null;
  altitude: number | null;
  speed: number | null;
  distance: number | null;
  /** as written by the band: revolutions or strides per minute (see workoutCadence) */
  cadence: number | null;
  /** °C, only on bands with a temperature sensor */
  temperature: number | null;
}

export async function workoutRecords(db: SqlExecutor, id: number): Promise<WorkoutRecord[]> {
  return db.all("SELECT * FROM workout_record WHERE workout_id = ? ORDER BY timestamp", [id]);
}

export interface WorkoutLap {
  idx: number;
  start_time: number;
  elapsed_s: number | null;
  timer_s: number | null;
  distance_m: number | null;
  calories: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_cadence: number | null;
  max_cadence: number | null;
  ascent_m: number | null;
  descent_m: number | null;
  lap_trigger: number | null;
}

export async function workoutLaps(db: SqlExecutor, id: number): Promise<WorkoutLap[]> {
  return db.all("SELECT * FROM workout_lap WHERE workout_id = ? ORDER BY idx", [id]);
}

export async function deleteWorkout(db: SqlExecutor, id: number) {
  await db.run("DELETE FROM workout WHERE id = ?", [id]);
}

// ------------------------------------------------------------------ stats

export async function tableCounts(db: SqlExecutor): Promise<Record<string, number>> {
  const tables = [
    "activity_sample", "stress_sample", "body_energy_sample", "spo2_sample", "respiratory_rate_sample", "resting_hr_sample",
    "sleep_stage_sample", "sleep_stats_sample", "hrv_summary_sample", "hrv_value_sample", "intensity_minutes_sample",
    "workout", "workout_record", "workout_lap", "fit_file",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number((await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t}`))?.n ?? 0);
  return out;
}

export async function deleteAllSamples(db: SqlExecutor, deviceId: number) {
  const tables = [
    "activity_sample", "stress_sample", "body_energy_sample", "spo2_sample", "respiratory_rate_sample", "resting_hr_sample",
    "sleep_stage_sample", "sleep_stats_sample", "sleep_restless_sample", "nap_sample", "hrv_summary_sample", "hrv_value_sample",
    "intensity_minutes_sample", "resting_metabolic_rate_sample", "workout", "sleep_session",
  ];
  await db.batch([
    ...tables.map((t) => ({ sql: `DELETE FROM ${t} WHERE device_id = ?`, params: [deviceId] })),
    { sql: "DELETE FROM meta WHERE key = ?", params: [`monitoring_state:${deviceId}`] },
  ]);
}
