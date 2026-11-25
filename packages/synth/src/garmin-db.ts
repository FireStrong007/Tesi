/**
 * Synthetic Garmin research server database: the same schema as the real one (core's
 * SERVER_SCHEMA, checked against the real server's sqlite_master) with made-up participants.
 * Each band's rows come from the demo generator's FIT files converted with Gadgetbridge's rules
 * (fit-to-server), so they have the real format's quirks: cumulative day counters per activity
 * type, midnight totals, -1 for "not measured", seconds/milliseconds.
 * Some sections are left empty on purpose, like in the real data (sleep for few participants,
 * SpO2 for one, nobody with HRV in the real server).
 */
import type { DatabaseSync } from "node:sqlite";
import { SERVER_SCHEMA, SERVER_TABLES, type ServerTable } from "@bridge/core/server/schema";
import { demoCohort } from "./demo/cohort";
import { DEFAULT_PERSONA, generateDemoFiles, rng, type Persona } from "./demo/generator";
import { fitToServerRows } from "./server/fit-to-server";
import { fakeHash, insertRows, writeDatabaseFile, type SqlRow } from "./sqlite-file";

export interface GarminParticipantSpec {
  /** participant.name: the participant's code */
  code: string;
  seed: number;
  /** days with data (0 = a participant with a band but no data yet) */
  days: number;
  /** the data stops this many days before `now` */
  endDaysAgo?: number;
  persona?: Partial<Persona>;
  /** tables left empty for this participant */
  omit?: ServerTable[];
  /** bands: with 2, the first one has the older half of the days */
  devices?: 1 | 2;
}

const SLEEP: ServerTable[] = ["GARMIN_SLEEP_STAGE_SAMPLE", "GARMIN_SLEEP_STATS_SAMPLE", "GARMIN_EVENT_SAMPLE"];
const HRV: ServerTable[] = ["GARMIN_HRV_SUMMARY_SAMPLE", "GARMIN_HRV_VALUE_SAMPLE"];

/** Default participants: everything, no sleep, no SpO2/HRV, two bands, old data, no data, ... */
export function defaultGarminParticipants(days = 28): GarminParticipantSpec[] {
  return [
    { code: "SYN-G01", seed: 101, days },
    { code: "SYN-G02", seed: 102, days, omit: [...SLEEP, ...HRV], persona: { activity: 1.1, restingHr: 62 } },
    { code: "SYN-G03", seed: 103, days, omit: ["GARMIN_SPO2_SAMPLE", ...HRV], persona: { activity: 0.6, stressBase: 30 } },
    { code: "SYN-G04", seed: 104, days, devices: 2, persona: { activity: 0.9, bedShift: 2400 } },
    { code: "SYN-G05", seed: 105, days: Math.min(days, 14), endDaysAgo: 21, omit: ["GARMIN_SPO2_SAMPLE"] },
    { code: "SYN-G06", seed: 106, days: 0 },
    { code: "SYN-G07", seed: 107, days, omit: [...SLEEP, "GARMIN_SPO2_SAMPLE", ...HRV], persona: { activity: 0.3, restingHr: 68 } },
    { code: "SYN-G08", seed: 108, days: Math.min(days, 3), omit: HRV },
  ];
}

/**
 * `n` more participants with the demo cohort's personas (varied activity, sleep, stress, ...), all
 * with data until now: enough people for the comparison with the others.
 */
export function cohortParticipants(n: number, days = 28): GarminParticipantSpec[] {
  return demoCohort(n).map((m, i) => ({ code: `SYN-C${String(i + 1).padStart(3, "0")}`, seed: m.seed, days, persona: m.persona, omit: m.hasSpo2 ? HRV : ["GARMIN_SPO2_SAMPLE", ...HRV] }));
}

const DAY_MS = 86_400_000;

/** Writes the participants' data into a database that already has SERVER_SCHEMA. */
export function fillGarminDb(db: DatabaseSync, participants: GarminParticipantSpec[], now: Date) {
  for (const [i, p] of participants.entries()) {
    const r = rng(p.seed * 7919);
    const created = now.getTime() - (p.days + (p.endDaysAgo ?? 0) + 2) * DAY_MS;
    const pid = Number(
      db.prepare("INSERT INTO participant (name, birthday, gender, api_key_hash, fcm_token, created_at) VALUES (?, NULL, NULL, ?, NULL, ?)").run(p.code, fakeHash(r), created)
        .lastInsertRowid,
    );
    const end = new Date(now.getTime() - (p.endDaysAgo ?? 0) * DAY_MS);
    const bands = p.devices ?? 1;
    const firstDays = bands === 2 ? Math.ceil(p.days / 2) : p.days;
    const periods = bands === 2 ? [{ days: firstDays, end: new Date(end.getTime() - (p.days - firstDays) * DAY_MS) }, { days: p.days - firstDays, end }] : [{ days: p.days, end }];
    for (const [k, period] of periods.entries()) {
      const serial = `SYN${String(i + 1).padStart(3, "0")}${k}`;
      const did = Number(
        db.prepare("INSERT INTO device (participant_id, identifier, name, manufacturer, type, type_name, model) VALUES (?, ?, 'vívosmart 5', 'Garmin', 0, 'GARMIN_VIVOSMART_5', '5')")
          .run(pid, serial).lastInsertRowid,
      );
      if (period.days <= 0) continue;
      const files = generateDemoFiles({ days: period.days, seed: p.seed * 10 + k, now: period.end, persona: { ...DEFAULT_PERSONA, ...p.persona } });
      const { rows } = fitToServerRows(files.map((f) => f.data));
      let last = 0;
      for (const [table, list] of Object.entries(rows) as [ServerTable, SqlRow[]][]) {
        if (p.omit?.includes(table) || !list.length) continue;
        const cols = SERVER_TABLES[table].cols;
        insertRows(db, table, list.map((row) => ({ USER_ID: pid, DEVICE_ID: did, ...Object.fromEntries(cols.map((c) => [c, row[c] ?? null])) })));
        if (table === "GARMIN_ACTIVITY_SAMPLE") for (const row of list) last = Math.max(last, Number(row.TIMESTAMP) * 1000);
      }
      // the phone uploads a few minutes after the band's last minute
      if (last) db.prepare("UPDATE device SET last_measurement_at = ?, last_successful_upload_at = ? WHERE id = ?").run(last, last + 120_000 + Math.floor(r() * 60_000), did);
    }
  }
}

/** Writes a complete synthetic Garmin server database file. */
export function writeGarminDb(path: string, opts: { now?: Date; participants?: GarminParticipantSpec[] } = {}) {
  const now = opts.now ?? new Date();
  writeDatabaseFile(path, SERVER_SCHEMA, (db) => fillGarminDb(db, opts.participants ?? defaultGarminParticipants(), now));
}
