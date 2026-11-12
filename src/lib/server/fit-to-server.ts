/**
 * Converts Garmin FIT files into the rows of the research server's tables (Gadgetbridge's format),
 * replicating Gadgetbridge's FitImporter (importFile + persistActivitySamples) so that the rows are
 * the same Gadgetbridge would store for the same files. Checked against the database of a real
 * Gadgetbridge export in tests/server-format.test.ts.
 *
 * Rows carry no USER_ID / DEVICE_ID: the server assigns them. Like Gadgetbridge, a later file
 * replaces the rows of an earlier one with the same key (insertOrReplace), so files must be added
 * in the order they were downloaded from the band.
 *
 * Known limit, kept on purpose (the server also receives data uploaded by Gadgetbridge for
 * Android, which must agree): the band writes the day's last totals in the sample at midnight;
 * when the next file starts at midnight with a sample without counters, that row is replaced and
 * the day loses what happened since its last sample (in a real export: up to a third of a day's
 * distance). The app's own import keeps those totals; the comparison reads the user's data in this
 * format too (user-mirror.ts), so "Tu" and the others share the same loss.
 */
import { decodeFit, num, type FitFile, type FitRecord } from "../fit/decoder";
import { GARMIN_EPOCH } from "../garmin/time";
import { ActivityKind, NOT_MEASURED, Spo2Type } from "./schema";

export type Row = Record<string, number | null>;

/** Server tables produced from FIT files, with their key columns (besides USER_ID / DEVICE_ID). */
export const SERVER_TABLES = {
  GARMIN_ACTIVITY_SAMPLE: { key: ["TIMESTAMP"], cols: ["TIMESTAMP", "RAW_INTENSITY", "STEPS", "RAW_KIND", "HEART_RATE", "DISTANCE_CM", "ACTIVE_CALORIES"] },
  GARMIN_STRESS_SAMPLE: { key: ["TIMESTAMP"], cols: ["TIMESTAMP", "STRESS"] },
  GARMIN_BODY_ENERGY_SAMPLE: { key: ["TIMESTAMP"], cols: ["TIMESTAMP", "ENERGY"] },
  GARMIN_EVENT_SAMPLE: { key: ["TIMESTAMP", "EVENT"], cols: ["TIMESTAMP", "EVENT", "EVENT_TYPE", "DATA"] },
  GARMIN_HEART_RATE_RESTING_SAMPLE: { key: ["TIMESTAMP"], cols: ["TIMESTAMP", "HEART_RATE"] },
  GARMIN_HRV_SUMMARY_SAMPLE: {
    key: ["TIMESTAMP"],
    cols: ["TIMESTAMP", "WEEKLY_AVERAGE", "LAST_NIGHT_AVERAGE", "LAST_NIGHT5_MIN_HIGH", "BASELINE_LOW_UPPER", "BASELINE_BALANCED_LOWER", "BASELINE_BALANCED_UPPER", "STATUS_NUM"],
  },
  GARMIN_HRV_VALUE_SAMPLE: { key: ["TIMESTAMP"], cols: ["TIMESTAMP", "VALUE"] },
  GARMIN_INTENSITY_MINUTES_SAMPLE: { key: ["TIMESTAMP"], cols: ["TIMESTAMP", "MODERATE", "VIGOROUS"] },
  GARMIN_NAP_SAMPLE: { key: ["TIMESTAMP"], cols: ["TIMESTAMP", "END_TIMESTAMP"] },
  GARMIN_RESPIRATORY_RATE_SAMPLE: { key: ["TIMESTAMP"], cols: ["TIMESTAMP", "RESPIRATORY_RATE"] },
  GARMIN_RESTING_METABOLIC_RATE_SAMPLE: { key: ["TIMESTAMP"], cols: ["TIMESTAMP", "RESTING_METABOLIC_RATE"] },
  GARMIN_SLEEP_STAGE_SAMPLE: { key: ["TIMESTAMP"], cols: ["TIMESTAMP", "STAGE"] },
  GARMIN_SLEEP_STATS_SAMPLE: { key: ["TIMESTAMP"], cols: ["TIMESTAMP", "SLEEP_SCORE"] },
  GARMIN_SPO2_SAMPLE: { key: ["TIMESTAMP"], cols: ["TIMESTAMP", "SPO2", "TYPE_NUM"] },
  BATTERY_LEVEL: { key: ["TIMESTAMP", "BATTERY_INDEX"], cols: ["TIMESTAMP", "LEVEL", "BATTERY_INDEX"] },
} as const;
export type ServerTable = keyof typeof SERVER_TABLES;

/** FIT file types (file_id.type) */
const FILE_ACTIVITY = 4;
const FILE_MONITOR = 32;
const FILE_SLEEP = 49;

/** The band as the server's `device` table should know it. */
export interface ServerDeviceInfo {
  /**
   * Stable identifier of the band: its Garmin serial number (FIT file_id.serial_number).
   * Gadgetbridge uses the Bluetooth MAC address, which Web Bluetooth does not expose and which a
   * vívosmart 5 changes at every new pairing (the same band showed three MACs in one export).
   */
  identifier: string | null;
  manufacturer: "Garmin";
  /** Garmin product number (file_id.product), e.g. 3720 for some vívosmart models */
  product: number | null;
}

export class ServerFormatConverter {
  private tables = new Map<ServerTable, Map<string, Row>>();
  private serial: number | null = null;
  private product: number | null = null;
  /** files that could not be read, with the reason */
  readonly errors: { index: number; error: string }[] = [];
  private files = 0;

  /** Adds one FIT file (in download order). Workouts (ACTIVITY files) only contribute events and samples. */
  addFile(bytes: Uint8Array) {
    const index = this.files++;
    let fit: FitFile;
    try {
      fit = decodeFit(bytes);
    } catch (e) {
      this.errors.push({ index, error: (e as Error).message });
      return;
    }
    this.importFile(fit);
  }

  device(): ServerDeviceInfo {
    return { identifier: this.serial != null ? String(this.serial) : null, manufacturer: "Garmin", product: this.product };
  }

  /** The rows of every table, ordered by key. */
  rows(): Record<ServerTable, Row[]> {
    const out = {} as Record<ServerTable, Row[]>;
    for (const t of Object.keys(SERVER_TABLES) as ServerTable[]) {
      const m = this.tables.get(t);
      out[t] = m ? [...m.values()].sort((a, b) => a.TIMESTAMP! - b.TIMESTAMP! || (a.EVENT ?? 0) - (b.EVENT ?? 0)) : [];
    }
    return out;
  }

  private put(table: ServerTable, row: Row) {
    let m = this.tables.get(table);
    if (!m) this.tables.set(table, (m = new Map()));
    m.set(SERVER_TABLES[table].key.map((k) => row[k]).join(":"), row);
  }

  // ------------------------------------------------------------------ FitImporter.importFile

  private importFile(fit: FitFile) {
    let fileType: number | null = null;
    // Gadgetbridge's "computed timestamp": the running time of the file (last field 253 or
    // compressed header), also for messages with their own time field (e.g. stress_level_time)
    let running: number | null = null;
    let lastMonitoring: number | null = null;
    const monitoring = new Map<number, FitRecord[]>();
    const sleepStages: Row[] = [];
    const pending: [ServerTable, Row][] = [];
    const add = (t: ServerTable, r: Row) => pending.push([t, r]);

    for (const rec of fit.records) {
      if (rec.timestamp !== null) running = rec.timestamp;
      const ts = running;
      const f = rec.fields;
      switch (rec.name) {
        case "file_id":
          fileType = num(f.type);
          if (num(f.serial_number) != null) this.serial = num(f.serial_number);
          if (num(f.product) != null) this.product = num(f.product);
          break;
        case "monitoring": {
          // FitMonitoring.computeTimestamp: timestamp_16 relative to the previous monitoring record,
          // otherwise the previous monitoring record's time, only the first one uses its own time
          const ts16 = num(rec.raw[26]);
          let t: number | null;
          if (ts16 !== null && lastMonitoring !== null) {
            let diff: number = (ts16 & 0xffff) - ((lastMonitoring - GARMIN_EPOCH) & 0xffff);
            if (diff < -32768) diff += 65536;
            else if (diff > 32768) diff -= 65536;
            t = lastMonitoring + diff;
          } else t = lastMonitoring ?? ts;
          if (t === null) break;
          lastMonitoring = t;
          const list = monitoring.get(t);
          if (list) list.push(rec);
          else monitoring.set(t, [rec]);
          break;
        }
        case "stress_level": {
          // FitStressLevel: its own stress_level_time when present
          const ts = num(f.stress_level_time) ?? running;
          if (ts === null) break;
          const stress = num(f.stress_level_value);
          if (stress !== null && stress >= 0) add("GARMIN_STRESS_SAMPLE", { TIMESTAMP: ts * 1000, STRESS: stress });
          const energy = num(f.body_energy);
          if (energy !== null) add("GARMIN_BODY_ENERGY_SAMPLE", { TIMESTAMP: ts * 1000, ENERGY: energy });
          break;
        }
        case "sleep_level": {
          const stage = num(f.sleep_level);
          if (stage === null || ts === null) break;
          sleepStages.push({ TIMESTAMP: ts * 1000, STAGE: stage });
          break;
        }
        case "sleep_assessment": {
          const score = num(f.overall_sleep_score);
          if (score === null || ts === null) break;
          add("GARMIN_SLEEP_STATS_SAMPLE", { TIMESTAMP: ts * 1000, SLEEP_SCORE: score });
          break;
        }
        case "nap_event": {
          const s = num(f.start_time);
          const e = num(f.end_time);
          if (s === null || e === null) break;
          add("GARMIN_NAP_SAMPLE", { TIMESTAMP: s * 1000, END_TIMESTAMP: e * 1000 });
          break;
        }
        case "spo2_data": {
          const spo2 = num(f.reading_spo2);
          if (spo2 === null || spo2 <= 0 || ts === null) break;
          const mode = num(f.mode);
          add("GARMIN_SPO2_SAMPLE", { TIMESTAMP: ts * 1000, SPO2: spo2, TYPE_NUM: mode === 1 ? Spo2Type.MANUAL : mode === 3 ? Spo2Type.AUTOMATIC : Spo2Type.UNKNOWN });
          break;
        }
        case "respiration_rate": {
          const rate = num(f.respiration_rate);
          if (rate === null || rate <= 0 || ts === null) break;
          add("GARMIN_RESPIRATORY_RATE_SAMPLE", { TIMESTAMP: ts * 1000, RESPIRATORY_RATE: rate });
          break;
        }
        case "event": {
          const ev = num(f.event);
          if (ev === null || ts === null) break;
          add("GARMIN_EVENT_SAMPLE", { TIMESTAMP: ts * 1000, EVENT: ev, EVENT_TYPE: num(f.event_type), DATA: num(f.data) });
          break;
        }
        case "hrv_status_summary": {
          if (ts === null) break;
          const r = (v: unknown) => (typeof v === "number" ? Math.round(v) : null);
          add("GARMIN_HRV_SUMMARY_SAMPLE", {
            TIMESTAMP: ts * 1000,
            WEEKLY_AVERAGE: r(f.weekly_average),
            LAST_NIGHT_AVERAGE: r(f.last_night_average),
            LAST_NIGHT5_MIN_HIGH: r(f.last_night_5_min_high),
            BASELINE_LOW_UPPER: r(f.baseline_low_upper),
            BASELINE_BALANCED_LOWER: r(f.baseline_balanced_lower),
            BASELINE_BALANCED_UPPER: r(f.baseline_balanced_upper),
            STATUS_NUM: num(f.status),
          });
          break;
        }
        case "hrv_value": {
          const v = num(f.value);
          if (v === null || ts === null) break;
          add("GARMIN_HRV_VALUE_SAMPLE", { TIMESTAMP: ts * 1000, VALUE: Math.round(v) });
          break;
        }
        case "monitoring_info": {
          const rmr = num(f.resting_metabolic_rate);
          if (rmr === null || ts === null) break;
          add("GARMIN_RESTING_METABOLIC_RATE_SAMPLE", { TIMESTAMP: ts * 1000, RESTING_METABOLIC_RATE: rmr });
          break;
        }
        case "monitoring_hr_data": {
          // the current day's value first: it is what the band displays
          const hr = num(f.current_day_resting_heart_rate) ?? num(f.resting_heart_rate);
          if (hr === null || ts === null) break;
          add("GARMIN_HEART_RATE_RESTING_SAMPLE", { TIMESTAMP: ts * 1000, HEART_RATE: hr });
          break;
        }
        case "battery": {
          const cap = num(f.capacity);
          if (cap === null || ts === null) break;
          add("BATTERY_LEVEL", { TIMESTAMP: ts, LEVEL: cap, BATTERY_INDEX: 0 });
          break;
        }
        default:
          break;
      }
    }
    if (fileType === null) {
      this.errors.push({ index: this.files - 1, error: "file senza file_id" });
      return;
    }

    // file-type specific rules, then the samples that can come in any file type
    if (fileType === FILE_MONITOR) this.persistActivitySamples(monitoring);
    // sleep stages only when the file has real ones (0 unmeasurable, 1 awake), Gadgetbridge #4048
    if (fileType === FILE_SLEEP && sleepStages.some((s) => s.STAGE !== 0 && s.STAGE !== 1)) for (const s of sleepStages) this.put("GARMIN_SLEEP_STAGE_SAMPLE", s);
    void FILE_ACTIVITY; // workouts: BASE_ACTIVITY_SUMMARY is not converted yet
    for (const [t, r] of pending) this.put(t, r);
  }

  // ------------------------------------------------------------------ FitImporter.persistActivitySamples

  private persistActivitySamples(perTimestamp: Map<number, FitRecord[]>) {
    if (!perTimestamp.size) return;
    // cumulative values per activity type, kept for the whole file; every sample gets their sum
    const steps = new Map<number, number>();
    const distance = new Map<number, number>();
    const calories = new Map<number, number>();
    const NOT_WORN_GAP = 10 * 60;
    let prevKind: number = ActivityKind.UNKNOWN;
    let prevTs = -1;
    const empty = (ts: number, kind: number): Row => ({
      TIMESTAMP: ts,
      RAW_INTENSITY: NOT_MEASURED,
      STEPS: NOT_MEASURED,
      RAW_KIND: kind,
      HEART_RATE: NOT_MEASURED,
      DISTANCE_CM: NOT_MEASURED,
      ACTIVE_CALORIES: NOT_MEASURED,
    });
    const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);

    for (const ts of [...perTimestamp.keys()].sort((a, b) => a - b)) {
      // gaps between samples: one row per minute, all not measured
      if (prevTs > 0 && ts - prevTs > 60)
        for (let i = prevTs + 60; i < ts; i += 60) this.put("GARMIN_ACTIVITY_SAMPLE", empty(i, ts - prevTs > NOT_WORN_GAP ? ActivityKind.NOT_WORN : prevKind));

      const sample = empty(ts, ActivityKind.ACTIVITY);
      let moderate = 0;
      let vigorous = 0;
      for (const r of perTimestamp.get(ts)!) {
        const ati = num(r.raw[24]);
        const type = num(r.raw[5]) ?? (ati !== null ? ati & 0x1f : NOT_MEASURED);
        const hr = num(r.raw[27]);
        if (hr !== null) sample.HEART_RATE = hr;
        // scaled values as Gadgetbridge reads them: cycles (raw / 2), distance in m (raw / 100)
        const cycles = num(r.fields.cycles);
        if (cycles !== null) steps.set(type, cycles);
        const dist = num(r.fields.distance);
        if (dist !== null) distance.set(type, dist);
        const cal = num(r.raw[19]);
        if (cal !== null) calories.set(type, cal);
        if (ati !== null) sample.RAW_INTENSITY = (ati >> 5) & 0x7;
        moderate += num(r.raw[33]) ?? 0;
        vigorous += num(r.raw[34]) ?? 0;
      }
      if (steps.size) sample.STEPS = Math.round(sum(steps) * 2);
      if (distance.size) sample.DISTANCE_CM = Math.round(sum(distance) * 100);
      if (calories.size) sample.ACTIVE_CALORIES = sum(calories);

      // empty samples are ignored (and do not move the gap reference)
      const measured = ["RAW_INTENSITY", "STEPS", "HEART_RATE", "DISTANCE_CM", "ACTIVE_CALORIES"].some((k) => sample[k] !== NOT_MEASURED);
      if (measured) {
        this.put("GARMIN_ACTIVITY_SAMPLE", sample);
        prevKind = sample.RAW_KIND!;
        prevTs = ts;
      }
      if (moderate !== 0 || vigorous !== 0) this.put("GARMIN_INTENSITY_MINUTES_SAMPLE", { TIMESTAMP: ts * 1000, MODERATE: moderate, VIGOROUS: vigorous });
    }
  }
}

/** Converts files (in download order) in one go. */
export function fitToServerRows(files: Uint8Array[]) {
  const c = new ServerFormatConverter();
  for (const f of files) c.addFile(f);
  return { rows: c.rows(), device: c.device(), errors: c.errors };
}
