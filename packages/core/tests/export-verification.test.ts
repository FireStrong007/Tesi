/**
 * The new Garmin adapter against the old app, on real data: the same days of the same band,
 * computed (a) by the legacy-bluetooth branch from an export's FIT files (importer + loadDay:
 * fixtures/export-expected.json, numbers only) and (b) here from the Gadgetbridge database of the
 * same export through the server views + loadDay.
 *
 * The rows of (b) are a person's health data: they are never in git. They are read from
 * data/export-device4.json (or $EXPORT_ROWS), made with
 *   npx tsx packages/synth/src/export-fixture.ts data/gadgetbridge_*.zip 4 data/export-device4.json
 * and the test is skipped without them.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadDay } from "../src/day-data";
import { DEFAULT_STRIDE_CM } from "../src/metrics";
import { insertServerRows } from "../src/server/server-source";
import type { Row, ServerTable } from "../src/server/schema";
import { createLocalViews } from "../src/server/views";
import { fromDayKey } from "../src/time-zone";
import expected from "./fixtures/export-expected.json";
import { addParticipant, serverDb } from "./helpers";

const ROWS = process.env.EXPORT_ROWS || fileURLToPath(new URL("../../../data/export-device4.json", import.meta.url));
const available = existsSync(ROWS);
if (!available) console.info(`Verifica con l'export saltata: manca ${ROWS} (righe del bracciale, fuori da git; vedi l'intestazione del test).`);

type DayValues = (typeof expected.days)["2026-11-04"];

async function computed() {
  const data = JSON.parse(readFileSync(ROWS, "utf8")) as { tables: Record<string, { cols: string[]; rows: (number | null)[][] }> };
  const db = serverDb();
  const { pid, did } = await addParticipant(db, "export");
  const rows: Partial<Record<ServerTable, Row[]>> = {};
  for (const [table, t] of Object.entries(data.tables)) rows[table as ServerTable] = t.rows.map((r) => Object.fromEntries(t.cols.map((c, i) => [c, r[i]])));
  await insertServerRows(db, pid, did, rows);
  await createLocalViews(db);
  const stride = (await db.all<{ s: number | null }>("SELECT stride_cm AS s FROM person_stride WHERE user_id = ?", [pid]))[0]?.s ?? null;
  const out: Record<string, DayValues & { distanceEstimatedM: number }> = {};
  for (const key of Object.keys(expected.days)) {
    const d = await loadDay(db, pid, fromDayKey(key));
    out[key] = {
      steps: d.steps,
      distanceM: Math.round(d.distanceM * 100) / 100,
      distanceEstimatedM: Math.round(d.distanceEstimatedM * 100) / 100,
      activeCalories: d.activeCalories,
      restingHr: d.restingHr!,
      stressByLevel: d.stressByLevel,
      energyCharged: d.energyCharged,
      energyDrained: d.energyDrained,
      sleep: (d.sleep ? { start: d.sleep.start, end: d.sleep.end, minutes: d.sleep.minutes, score: d.sleep.score } : null) as DayValues["sleep"],
      sleepMinutes: d.sleepMinutes,
    };
  }
  return { days: out, stride };
}

/**
 * Distance: the server's Gadgetbridge rows lose part of it (docs/stato-lavori.md). Where a day's
 * steps are all covered by measured distance the value equals the old app's; steps with no
 * measured distance get an estimate (steps × the person's average step length); a loss hidden in
 * the counter itself (5 November: a type's distance not repeated in later files) cannot be seen
 * and stays. The differences are recorded here.
 */
const DISTANCE = {
  "2026-11-03": { legacy: 305.37, nuovo: 251.41, stimata: 245.74 },
  "2026-11-04": { legacy: 2101.02, nuovo: 2101.02, stimata: 0 },
  "2026-11-05": { legacy: 3652.42, nuovo: 2473.6, stimata: 0 },
  "2026-11-06": { legacy: 570.22, nuovo: 570.22, stimata: 0 },
};

describe.skipIf(!available)("daily values of a real export: new adapter (Gadgetbridge database) = old app (FIT files)", async () => {
  const ours = available ? await computed() : { days: {}, stride: null };
  const without = (v: object) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== "distanceM" && k !== "distanceEstimatedM"));
  for (const key of Object.keys(expected.days)) {
    it(`${key}${expected.complete.includes(key) ? "" : " (giorno parziale)"}: passi, calorie, battito a riposo, stress, Body Battery, sonno`, () => {
      expect(without(ours.days[key])).toEqual(without(expected.days[key as keyof typeof expected.days]));
    });
  }
  it("the steps Gadgetbridge showed", () => {
    for (const [key, steps] of Object.entries(expected.known.steps)) expect(ours.days[key].steps, key).toBe(steps);
  });
  it("distance: measured where the rows have it, estimated for steps with none (recorded difference)", () => {
    expect(ours.stride).not.toBeNull(); // enough minutes with both values: the person's own step length
    expect(ours.stride).not.toBe(DEFAULT_STRIDE_CM);
    for (const key of Object.keys(expected.days)) {
      const legacy = expected.days[key as keyof typeof expected.days].distanceM;
      expect({ legacy, nuovo: ours.days[key].distanceM, stimata: ours.days[key].distanceEstimatedM }, key).toEqual(DISTANCE[key as keyof typeof DISTANCE]);
    }
  });
});
