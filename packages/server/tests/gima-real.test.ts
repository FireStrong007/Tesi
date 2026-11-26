/**
 * The Gima adapter on the real research database (data/GimaDB.db, never in git: skipped without
 * it, or GIMA_DB for another copy). The expected values come from the same database, never from a
 * fixture: the sleep minutes of the adapter against the watch's own night totals
 * (GIMA_SLEEP_STATS_SAMPLE), the valid temperatures, the ECG recordings' length at 83.33 Hz.
 * The file is attached read-only (immutable=1): nothing is written next to it.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createAppTables } from "@bridge/core/adapters";
import { ecgRecordings, sleepSessions } from "@bridge/core/db/queries";
import { ECG_SAMPLE_RATE_HZ } from "@bridge/core/gima/ecg";
import { executor } from "../src/sqlite";

const FILE = resolve(import.meta.dirname, "../../..", process.env.GIMA_DB ?? "data/GimaDB.db");
const present = existsSync(FILE);
if (!present) console.warn(`gima-real: ${FILE} non c'è, test saltato (serve la copia del database Gima in data/, mai in git)`);

async function open() {
  const url = pathToFileURL(FILE);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  const raw = new DatabaseSync(":memory:");
  raw.prepare("ATTACH DATABASE ? AS src").run(url.href);
  const db = executor(raw);
  await createAppTables(db, "heartbridge", { materialize: true });
  return { raw, db };
}

describe.skipIf(!present)("Gima adapter on the real database", () => {
  it("each night's deep and light minutes are the watch's own totals (within a minute per segment)", async () => {
    const { raw, db } = await open();
    const people = raw.prepare("SELECT id FROM src.participant").all() as { id: number }[];
    let nights = 0;
    for (const { id } of people) {
      const sessions = await sleepSessions(db, id, 0, 2_000_000_000);
      for (const s of sessions) {
        const stats = raw
          .prepare("SELECT sum(DEEP_SLEEP_TOT_MIN) AS deep, sum(LIGHT_SLEEP_TOT_MIN) AS light, count(*) AS n FROM src.GIMA_SLEEP_STATS_SAMPLE WHERE USER_ID = ? AND TIMESTAMP >= ? AND TIMESTAMP_END <= ?")
          .get(id, s.start * 1000, s.end * 1000) as { deep: number; light: number; n: number };
        if (!stats.n) continue;
        nights++;
        expect(Math.abs(s.minutes.deep - stats.deep)).toBeLessThanOrEqual(stats.n);
        expect(Math.abs(s.minutes.light - stats.light)).toBeLessThanOrEqual(stats.n);
        // segments of the same night: one session, the pauses awake
        expect(s.minutes.rem).toBe(0);
      }
    }
    expect(nights).toBeGreaterThan(0);
    raw.close();
  });

  it("only valid values: temperatures between 30 and 43 °C, no zeros", async () => {
    const { raw, db } = await open();
    const all = (sql: string) => raw.prepare(sql).get() as Record<string, number>;
    expect(all("SELECT count(*) AS n FROM temp.body_temperature_sample").n).toBe(all("SELECT count(*) AS n FROM src.GIMA_BODY_TEMPERATURE_SAMPLE WHERE TEMPERATURE BETWEEN 30 AND 43").n);
    expect(all("SELECT count(*) AS n FROM temp.body_temperature_sample WHERE temperature < 30 OR temperature > 43").n).toBe(0);
    for (const [table, col] of [["spo2_sample", "spo2"], ["respiratory_rate_sample", "rate"], ["hrv_value_sample", "value"], ["blood_pressure_sample", "systolic"]])
      expect(all(`SELECT count(*) AS n FROM temp.${table} WHERE ${col} <= 0`).n, table).toBe(0);
    expect(all("SELECT count(*) AS n FROM temp.activity_sample WHERE heart_rate <= 0").n).toBe(0);
    expect((await db.all("SELECT 1 FROM temp.ecg_recording WHERE ai_heart > 300")).length).toBe(0);
    raw.close();
  });

  it("ECG recordings last about a minute at 83.33 Hz, never longer than the measurement's start-to-send time", async () => {
    const { raw, db } = await open();
    const people = raw.prepare("SELECT id FROM src.participant").all() as { id: number }[];
    let n = 0;
    for (const { id } of people)
      for (const r of await ecgRecordings(db, id, 0, 2_000_000_000)) {
        n++;
        const seconds = r.sample_count / ECG_SAMPLE_RATE_HZ;
        expect(seconds).toBeGreaterThan(55);
        expect(seconds).toBeLessThan(65);
        if (r.duration_s != null) expect(seconds).toBeLessThan(r.duration_s);
      }
    expect(n).toBeGreaterThan(0);
    raw.close();
  });
});
