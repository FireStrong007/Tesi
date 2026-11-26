/**
 * Synthetic Gima (Sportpix) research server database: the real schema (core's GIMA_SCHEMA, copied
 * from the real server's sqlite_master) with made-up participants. Rows are generated directly,
 * with the real data's shape: times in milliseconds, activity in 30-minute blocks (steps of the
 * block, only blocks with steps), sleep stages as start + DURATION_SEC (241 deep, 242 light), and
 * the invalid values found in the real data (temperature 0.15 °C, 0 = not measured, ai_heart
 * above 300, ECG without duration). Some sections are left empty on purpose. Some nights are split
 * in two segments with a pause awake, like a real one. ECG samples are at 250 / 3 Hz (core's
 * gima/ecg.ts), clipped to ±500; duration_ms is the start-to-send time, a few seconds longer.
 */
import type { DatabaseSync } from "node:sqlite";
import { ECG_SAMPLE_RATE_HZ } from "@bridge/core/gima/ecg";
import { GIMA_SCHEMA } from "@bridge/core/gima/schema";
import { rng } from "./demo/generator";
import { fakeHash, insertRows, writeDatabaseFile, type SqlRow } from "./sqlite-file";

export type GimaTable =
  | "GIMA_ACTIVITY_SAMPLE"
  | "GIMA_HEART_RATE_SAMPLE"
  | "GIMA_BLOOD_PRESSURE_SAMPLE"
  | "GIMA_SPO2_SAMPLE"
  | "GIMA_RESPIRATORY_RATE_SAMPLE"
  | "GIMA_BODY_TEMPERATURE_SAMPLE"
  | "GIMA_HRV_VALUE_SAMPLE"
  | "GIMA_SLEEP_STAGE_SAMPLE"
  | "GIMA_SLEEP_STATS_SAMPLE"
  | "ECG_MEASUREMENTS";

export interface GimaParticipantSpec {
  code: string;
  seed: number;
  /** days with data (0 = a watch but no data yet) */
  days: number;
  endDaysAgo?: number;
  /** ECG recordings over the period */
  ecgs?: number;
  omit?: GimaTable[];
}

export function defaultGimaParticipants(days = 21): GimaParticipantSpec[] {
  return [
    { code: "SYN-H01", seed: 201, days, ecgs: 6 },
    { code: "SYN-H02", seed: 202, days: Math.min(days, 14), ecgs: 2, omit: ["GIMA_SLEEP_STAGE_SAMPLE", "GIMA_SLEEP_STATS_SAMPLE"] },
    { code: "SYN-H03", seed: 203, days, ecgs: 0 },
    { code: "SYN-H04", seed: 204, days, ecgs: 3, omit: ["GIMA_BLOOD_PRESSURE_SAMPLE", "GIMA_BODY_TEMPERATURE_SAMPLE"] },
    { code: "SYN-H05", seed: 205, days: 0 },
    { code: "SYN-H06", seed: 206, days: Math.min(days, 7), endDaysAgo: 30, ecgs: 3 },
  ];
}

/** `n` more participants with every section, data until now: enough people for the comparison */
export function gimaCohortParticipants(n: number, days = 21): GimaParticipantSpec[] {
  return Array.from({ length: n }, (_, i) => ({ code: `SYN-K${String(i + 1).padStart(3, "0")}`, seed: 5000 + i, days, ecgs: i % 3 }));
}

const MIN = 60_000;
const DAY = 86_400_000;

/** Signed 32-bit little-endian samples, like ECG_MEASUREMENTS.ecg_data. */
export function ecgBlob(samples: Int32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 4);
  const view = new DataView(out.buffer);
  samples.forEach((v, i) => view.setInt32(i * 4, v, true));
  return out;
}

/** A made-up ECG trace (P, QRS, T waves plus noise), clipped to ±500 like the real samples. */
export function syntheticEcg(count: number, bpm: number, r: () => number, rateHz = ECG_SAMPLE_RATE_HZ): Int32Array {
  const out = new Int32Array(count);
  const beat = (60 / bpm) * rateHz;
  const g = (x: number, mu: number, sigma: number, a: number) => a * Math.exp(-((x - mu) ** 2) / (2 * sigma ** 2));
  for (let i = 0; i < count; i++) {
    const x = (i % beat) / beat; // phase in the beat
    const v = g(x, 0.2, 0.025, 45) + g(x, 0.33, 0.008, -60) + g(x, 0.35, 0.01, 470) + g(x, 0.375, 0.01, -130) + g(x, 0.6, 0.04, 90) + (r() - 0.5) * 16;
    out[i] = Math.max(-500, Math.min(500, Math.round(v)));
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const localString = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function fillGimaDb(db: DatabaseSync, participants: GimaParticipantSpec[], now: Date) {
  for (const [i, p] of participants.entries()) {
    const r = rng(p.seed * 104_729);
    const between = (lo: number, hi: number) => lo + r() * (hi - lo);
    const endMs = now.getTime() - (p.endDaysAgo ?? 0) * DAY;
    const created = endMs - (p.days + 2) * DAY;
    const pid = Number(
      db.prepare("INSERT INTO participant (name, birthday, gender, api_key_hash, fcm_token, created_at) VALUES (?, NULL, NULL, ?, NULL, ?)").run(p.code, fakeHash(r), created).lastInsertRowid,
    );
    const did = Number(
      db.prepare("INSERT INTO device (participant_id, name, identifier, hardware_id, firmware_version) VALUES (?, ?, ?, ?, '1.0')")
        .run(pid, `01-SYN${i + 1} ${String(p.seed).padStart(4, "0")}`, `SYN-GIMA-${p.seed}`, `HW-SYN-${p.seed}`).lastInsertRowid,
    );
    if (p.days <= 0) continue;
    const rows: Record<GimaTable, SqlRow[]> = {
      GIMA_ACTIVITY_SAMPLE: [], GIMA_HEART_RATE_SAMPLE: [], GIMA_BLOOD_PRESSURE_SAMPLE: [], GIMA_SPO2_SAMPLE: [], GIMA_RESPIRATORY_RATE_SAMPLE: [],
      GIMA_BODY_TEMPERATURE_SAMPLE: [], GIMA_HRV_VALUE_SAMPLE: [], GIMA_SLEEP_STAGE_SAMPLE: [], GIMA_SLEEP_STATS_SAMPLE: [], ECG_MEASUREMENTS: [],
    };
    const ids = { DEVICE_ID: did, USER_ID: pid };
    const restHr = Math.round(between(58, 74));
    const sys = between(104, 124);
    const dia = between(66, 80);
    const end = new Date(endMs);
    for (let d = p.days - 1; d >= 0; d--) {
      const day = new Date(end.getFullYear(), end.getMonth(), end.getDate() - d).getTime();
      const until = Math.min(day + DAY, endMs);
      // heart rate and blood pressure, measured together about every 18 minutes
      for (let t = day + Math.floor(between(0, 18)) * MIN; t < until; t += Math.round(between(14, 22)) * MIN + Math.floor(between(0, 60_000))) {
        const h = new Date(t).getHours();
        const awake = h >= 7 && h < 23;
        rows.GIMA_HEART_RATE_SAMPLE.push({ TIMESTAMP: t, ...ids, HEART_RATE: Math.round(restHr + (awake ? between(5, 35) : between(-6, 4))) });
        const invalid = r() < 0.01;
        rows.GIMA_BLOOD_PRESSURE_SAMPLE.push({ TIMESTAMP: t, ...ids, BP_SYSTOLIC: invalid ? 0 : Math.round(sys + between(-8, 10)), BP_DIASTOLIC: invalid ? 0 : Math.round(dia + between(-6, 8)) });
        if (r() < 0.72) {
          const t2 = t + 1000;
          // most temperature readings are the watch's invalid 0.15 °C
          rows.GIMA_BODY_TEMPERATURE_SAMPLE.push({ TIMESTAMP: t2, ...ids, TEMPERATURE: r() < 0.8 ? 0.15 : Math.round(between(35.2, 37.1) * 100) / 100 });
          rows.GIMA_HRV_VALUE_SAMPLE.push({ TIMESTAMP: t2, ...ids, HRV: r() < 0.01 ? 0 : Math.round(between(18, 46)), CVRR: Math.round(between(0, 6)) });
          rows.GIMA_SPO2_SAMPLE.push({ TIMESTAMP: t2, ...ids, SPO2: r() < 0.005 ? 0 : Math.round(between(93, 98)) });
          rows.GIMA_RESPIRATORY_RATE_SAMPLE.push({ TIMESTAMP: t2, ...ids, RESPIRATORY_RATE: r() < 0.005 ? 0 : Math.round(between(12, 20)) });
        }
      }
      // steps in 30-minute blocks, only the blocks with steps
      for (let b = 0; b < 48; b++) {
        const t = day + b * 30 * MIN;
        if (t + 30 * MIN > until) break;
        const h = b / 2;
        if (h < 7 || h >= 23 || r() < 0.35) continue;
        const steps = Math.round(r() < 0.15 ? between(800, 2200) : between(20, 600));
        rows.GIMA_ACTIVITY_SAMPLE.push({ TIMESTAMP: t, TIMESTAMP_END: t + 30 * MIN, ...ids, STEPS: steps, DISTANCE_CM: Math.round(steps * 0.8), ACTIVE_CALORIES: Math.round(steps / 25) });
      }
      // the night that ends this morning
      const sleepStart = day - Math.round(between(30, 90)) * MIN;
      const sleepEnd = day + Math.round(between(6 * 60, 7.5 * 60)) * MIN;
      if (sleepEnd <= until && r() < 0.75) {
        // one night in five is split in two segments, with 10–40 minutes awake in between
        const pauseAt = r() < 0.2 ? sleepEnd - Math.round(between(50, 90)) * MIN : null;
        const pause = Math.round(between(10, 40)) * MIN;
        let t = sleepStart;
        let segStart = sleepStart;
        let deep = 0, light = 0, deepCount = 0, lightCount = 0;
        const closeSegment = (end: number) => {
          rows.GIMA_SLEEP_STATS_SAMPLE.push({
            TIMESTAMP: segStart, TIMESTAMP_END: end, ...ids, RAPID_EYE_MOVEMENT_TOT: 0,
            DEEP_SLEEP_COUNT: deepCount, LIGHT_SLEEP_COUNT: lightCount, DEEP_SLEEP_TOT_MIN: Math.round(deep), LIGHT_SLEEP_TOT_MIN: Math.round(light),
          });
          deep = light = deepCount = lightCount = 0;
        };
        let paused = false;
        for (let k = 0; t < sleepEnd; k++) {
          if (pauseAt != null && !paused && t >= pauseAt) {
            closeSegment(t);
            paused = true;
            t += pause;
            segStart = t;
            if (t >= sleepEnd) break;
          }
          const isDeep = k % 2 === 1;
          const dur = Math.min(Math.round(isDeep ? between(20, 50) : between(40, 90)) * 60, Math.round((sleepEnd - t) / 1000));
          rows.GIMA_SLEEP_STAGE_SAMPLE.push({ TIMESTAMP: t, ...ids, DURATION_SEC: dur, STAGE: isDeep ? 241 : 242 });
          if (isDeep) (deep += dur / 60), deepCount++;
          else (light += dur / 60), lightCount++;
          t += dur * 1000;
        }
        if (deepCount + lightCount) closeSegment(t);
      }
    }
    // ECG recordings: about half without duration and values (like the real ones), device assessments as found
    const diagnoses = [1, 1, 5, 1, 9, 1, 1, 1];
    for (let k = 0; k < (p.ecgs ?? 0); k++) {
      const start = endMs - Math.round(((k + 0.5) / (p.ecgs ?? 1)) * p.days * DAY) + Math.round(between(-3, 3)) * 3600_000;
      const count = Math.round(between(5040, 5130));
      const measured = k % 2 === 0;
      const bpm = Math.round(between(66, 88));
      rows.ECG_MEASUREMENTS.push({
        timestamp_string: localString(start), start_measure_ms: start,
        duration_ms: measured ? Math.round((count / ECG_SAMPLE_RATE_HZ) * 1000 + between(5000, 12000)) : 0, sample_count: count,
        heart: measured ? bpm : 0, dbp: measured ? Math.round(dia) : 0, sbp: measured ? Math.round(sys) : 0, hrv: measured ? Math.round(between(28, 60)) : 0,
        is_afib: p.seed === 201 && k === 3 ? 1 : 0, diagnose_type: diagnoses[k % diagnoses.length],
        ai_heart: k % 4 === 3 ? 400 : Math.round(between(70, 160)), ...ids, ecg_data: ecgBlob(syntheticEcg(count, bpm, r)),
      });
    }
    let last = 0;
    for (const [table, list] of Object.entries(rows) as [GimaTable, SqlRow[]][]) {
      if (p.omit?.includes(table)) continue;
      insertRows(db, table, list);
      for (const row of list) last = Math.max(last, Number(row.TIMESTAMP ?? row.start_measure_ms));
    }
    if (last) db.prepare("UPDATE device SET last_measurement_at = ?, last_successful_upload_at = ? WHERE id = ?").run(last, last + 90_000 + Math.floor(r() * 60_000), did);
  }
}

export function writeGimaDb(path: string, opts: { now?: Date; participants?: GimaParticipantSpec[] } = {}) {
  const now = opts.now ?? new Date();
  writeDatabaseFile(path, GIMA_SCHEMA, (db) => fillGimaDb(db, opts.participants ?? defaultGimaParticipants(), now));
}
