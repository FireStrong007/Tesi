/**
 * The current user's data in the research server's format, for the comparison with other people:
 * their stored FIT files are converted as Gadgetbridge would (fit-to-server) into a separate
 * database with the server schema, then read through the same views as every other participant.
 * "Tu" and the others then share the same rules and the same limits of the format (e.g. the
 * midnight totals overwritten by the next file), so the comparison is fair. The chart bars keep
 * the app's own values.
 */
import type { SqlExecutor } from "../db/sql";
import { STUDY_TIME_ZONE } from "../time-zone";
import { loadRange, type RangeData } from "../range-data";
import { SERVER_TABLES, ServerFormatConverter, type ServerTable } from "./fit-to-server";
import { SERVER_SCHEMA } from "./schema";
import { insertServerRows } from "./server-source";
import { createLocalViews } from "./views";

/** the participant id the user gets in the scratch database */
const ME = 1;
/** what the scratch database of each app database holds now: user and files, to rebuild only when they change */
const built = new WeakMap<SqlExecutor, string>();

/**
 * loadRange of the user's own data in the server format. `main` is the app's database (FIT files
 * kept in fit_file), `scratch` an empty database used only for this (e.g. DbClient.scratch()).
 */
export function userServerRange(main: SqlExecutor, scratch: SqlExecutor, userId: number, from: number, to: number, timeZone?: string): Promise<RangeData> {
  // one at a time: requests share the scratch database
  const next = queue.then(() => run(main, scratch, userId, from, to, timeZone));
  queue = next.catch(() => undefined);
  return next;
}
let queue: Promise<unknown> = Promise.resolve();

async function run(main: SqlExecutor, scratch: SqlExecutor, userId: number, from: number, to: number, timeZone?: string): Promise<RangeData> {
  const sig = (
    await main.all<{ n: number; last: number | null }>(
      "SELECT COUNT(*) AS n, MAX(f.id) AS last FROM fit_file f JOIN device d ON d.id = f.device_id WHERE d.user_id = ?",
      [userId],
    )
  )[0];
  const key = `${userId}:${sig.n}:${sig.last}:${timeZone ?? ""}`;
  if (built.get(main) !== key) {
    await rebuild(main, scratch, userId, timeZone);
    built.set(main, key);
  }
  return loadRange(scratch, ME, from, to);
}

async function rebuild(main: SqlExecutor, scratch: SqlExecutor, userId: number, timeZone?: string) {
  for (const sql of SERVER_SCHEMA.split(";").map((s) => s.trim()).filter((s) => s && !/^PRAGMA/i.test(s))) await scratch.run(sql);
  for (const t of [...(Object.keys(SERVER_TABLES) as ServerTable[]), "collection_request", "device", "participant"]) await scratch.run(`DELETE FROM "${t}"`);
  await scratch.run("INSERT INTO participant (id, name, api_key_hash, created_at) VALUES (?, 'io', 'locale', 0)", [ME]);
  const devices = await main.all<{ id: number; name: string; unit_number: string | null }>("SELECT id, name, unit_number FROM device WHERE user_id = ? ORDER BY id", [userId]);
  for (const d of devices) {
    // in download order, like Gadgetbridge imports them; one file at a time (they can be large)
    const ids = await main.all<{ id: number }>("SELECT id FROM fit_file WHERE device_id = ? ORDER BY file_date, id", [d.id]);
    if (!ids.length) continue;
    const conv = new ServerFormatConverter();
    for (const { id } of ids) {
      const row = (await main.all<{ data: Uint8Array }>("SELECT data FROM fit_file WHERE id = ?", [id]))[0];
      if (row?.data) conv.addFile(row.data);
    }
    const identifier = conv.device().identifier ?? d.unit_number ?? `locale-${d.id}`;
    const dev = await scratch.run(
      "INSERT INTO device (participant_id, identifier, name, manufacturer, type, type_name) VALUES (?, ?, ?, 'Garmin', 0, 'GARMIN')",
      [ME, identifier, d.name],
    );
    await insertServerRows(scratch, ME, dev.lastInsertRowid, conv.rows());
  }
  await createLocalViews(scratch, { materialize: true, timeZone: timeZone ?? STUDY_TIME_ZONE });
}
