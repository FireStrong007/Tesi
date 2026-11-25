import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { DATASETS } from "@bridge/core/datasets";
import { diffSnapshots, snapshotDir } from "../src/data-guard";
import { cohortParticipants, defaultGarminParticipants, writeGarminDb } from "../src/garmin-db";
import { defaultGimaParticipants, writeGimaDb } from "../src/gima-db";

const dir = mkdtempSync(join(tmpdir(), "bridge-synth-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const NOW = new Date("2026-11-20T12:00:00");

const count = (db: DatabaseSync, sql: string, ...p: (string | number)[]) => Number((db.prepare(sql).get(...p) as { n: number }).n);

describe("synthetic server databases", () => {
  it("Garmin: the real schema, several participants, some sections empty on purpose", () => {
    const path = join(dir, "garmin.db");
    writeGarminDb(path, { now: NOW, participants: defaultGarminParticipants(4) });
    const db = new DatabaseSync(path, { readOnly: true });
    expect(count(db, "SELECT user_version AS n FROM pragma_user_version")).toBe(1);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables.sort()).toEqual([...DATASETS.vitabridge.requiredTables].sort());
    expect(count(db, "SELECT count(*) AS n FROM participant")).toBe(8);
    expect(count(db, "SELECT count(*) AS n FROM device")).toBe(9); // one participant has two bands
    // counters are cumulative and -1 means not measured, like Gadgetbridge
    expect(count(db, "SELECT count(*) AS n FROM GARMIN_ACTIVITY_SAMPLE WHERE HEART_RATE = -1")).toBeGreaterThan(0);
    const p = (code: string) => count(db, "SELECT id AS n FROM participant WHERE name = ?", code);
    expect(count(db, "SELECT count(*) AS n FROM GARMIN_ACTIVITY_SAMPLE WHERE USER_ID = ?", p("SYN-G06"))).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM GARMIN_SLEEP_STAGE_SAMPLE WHERE USER_ID = ?", p("SYN-G02"))).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM GARMIN_SLEEP_STAGE_SAMPLE WHERE USER_ID = ?", p("SYN-G01"))).toBeGreaterThan(0);
    expect(count(db, "SELECT count(DISTINCT DEVICE_ID) AS n FROM GARMIN_ACTIVITY_SAMPLE WHERE USER_ID = ?", p("SYN-G04"))).toBe(2);
    expect(count(db, "SELECT count(*) AS n FROM device WHERE last_successful_upload_at IS NOT NULL")).toBe(8 - 1 + 1 - 0); // all bands with data
    db.close();
  });

  it("Garmin cohort (--cohort): every participant with data every hour up to the generation time, sleep every night, SpO2 for a part", () => {
    const path = join(dir, "garmin-cohort.db");
    const days = 6;
    writeGarminDb(path, { now: NOW, participants: cohortParticipants(12, days) });
    const db = new DatabaseSync(path, { readOnly: true });
    const ids = (db.prepare("SELECT id, name FROM participant ORDER BY id").all() as { id: number; name: string }[]);
    expect(ids.map((p) => p.name)).toEqual(Array.from({ length: 12 }, (_, i) => `SYN-C${String(i + 1).padStart(3, "0")}`));
    const nowS = NOW.getTime() / 1000;
    for (const { id, name } of ids) {
      // heart rate in every hour from the first one to the generation time: no gap, up to now
      const first = count(db, "SELECT min(TIMESTAMP) AS n FROM GARMIN_ACTIVITY_SAMPLE WHERE USER_ID = ? AND HEART_RATE > 0", id);
      const last = count(db, "SELECT max(TIMESTAMP) AS n FROM GARMIN_ACTIVITY_SAMPLE WHERE USER_ID = ? AND HEART_RATE > 0", id);
      const hours = count(db, "SELECT count(DISTINCT TIMESTAMP / 3600) AS n FROM GARMIN_ACTIVITY_SAMPLE WHERE USER_ID = ? AND HEART_RATE > 0", id);
      expect(nowS - last, name).toBeLessThan(3600);
      // whole days: from the first hour of the first day to now
      expect(Math.floor(first / 3600), name).toBe(new Date("2026-11-20T00:00:00").getTime() / 1000 / 3600 - (days - 1) * 24);
      expect(hours, name).toBe(Math.floor(last / 3600) - Math.floor(first / 3600) + 1);
      // a night of sleep for every day (stage samples are in milliseconds)
      const nights = count(db, "SELECT count(DISTINCT date(TIMESTAMP / 1000 + 3600, 'unixepoch')) AS n FROM GARMIN_SLEEP_STAGE_SAMPLE WHERE USER_ID = ?", id);
      expect(nights, name).toBeGreaterThanOrEqual(days);
    }
    const withSpo2 = count(db, "SELECT count(DISTINCT USER_ID) AS n FROM GARMIN_SPO2_SAMPLE");
    expect(withSpo2).toBeGreaterThan(0);
    expect(withSpo2).toBeLessThan(12);
    expect(count(db, "SELECT count(*) AS n FROM GARMIN_HRV_VALUE_SAMPLE")).toBe(0); // the vívosmart 5 does not measure it
    db.close();
  });

  it("Gima: the real schema, invalid values like the real data, ECG blobs of 32-bit samples", () => {
    const path = join(dir, "gima.db");
    writeGimaDb(path, { now: NOW, participants: defaultGimaParticipants(5) });
    const db = new DatabaseSync(path, { readOnly: true });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables.sort()).toEqual([...DATASETS.heartbridge.requiredTables].sort());
    expect(count(db, "SELECT count(*) AS n FROM GIMA_BODY_TEMPERATURE_SAMPLE WHERE TEMPERATURE < 30")).toBeGreaterThan(0);
    expect(count(db, "SELECT count(*) AS n FROM GIMA_SLEEP_STAGE_SAMPLE WHERE STAGE NOT IN (241, 242)")).toBe(0);
    const ecg = db.prepare("SELECT sample_count, length(ecg_data) AS bytes, duration_ms FROM ECG_MEASUREMENTS").all() as { sample_count: number; bytes: number; duration_ms: number }[];
    expect(ecg.length).toBeGreaterThan(0);
    for (const e of ecg) expect(e.bytes).toBe(e.sample_count * 4);
    expect(ecg.some((e) => e.duration_ms === 0)).toBe(true);
    expect(count(db, "SELECT count(*) AS n FROM ECG_MEASUREMENTS WHERE ai_heart > 300")).toBeGreaterThan(0);
    db.close();
  });
});

describe("data/ guard (vitest.global-setup.ts)", () => {
  it("sees a changed, a removed and a new file, and nothing when the folder is untouched", async () => {
    const d = join(dir, "guard");
    mkdirSync(d);
    writeFileSync(join(d, "a.db"), "uno");
    writeFileSync(join(d, "b.db"), "due");
    const before = await snapshotDir(d);
    expect(diffSnapshots(before, await snapshotDir(d))).toEqual([]);
    writeFileSync(join(d, "a.db"), "uno!");
    rmSync(join(d, "b.db"));
    writeFileSync(join(d, "a.db-wal"), "");
    expect(diffSnapshots(before, await snapshotDir(d))).toEqual(["a.db: modificato", "b.db: rimosso", "a.db-wal: nuovo file"]);
    expect(await snapshotDir(join(d, "non-esiste"))).toEqual({});
  });
});
