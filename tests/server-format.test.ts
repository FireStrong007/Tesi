import { describe, expect, it } from "vitest";
import { userDailyValues } from "../src/lib/comparison/daily-values";
import { COMPARE_METRICS } from "../src/lib/comparison/types";
import { importFit } from "../src/lib/db/importer";
import { addDays, addDevice, ensureDefaultUser, startOfDay } from "../src/lib/db/repo";
import { oo1All, oo1Executor } from "../src/lib/db/sql";
import { loadRange } from "../src/lib/range-data";
import { createLocalViews } from "../src/lib/server/views";
import { memoryDb } from "./helpers";
import { SERVER_TABLES, fitToServerRows, type Row, type ServerTable } from "../src/lib/server/fit-to-server";
import { GB_EXPORT, loadGbExport } from "./gb-export";

/** Rows of one table that differ between our conversion and Gadgetbridge's database. */
function diffTable(table: ServerTable, ours: Row[], theirs: Row[]) {
  const { key, cols } = SERVER_TABLES[table];
  const k = (r: Row) => key.map((c) => r[c]).join(":");
  const a = new Map(ours.map((r) => [k(r), r]));
  const b = new Map(theirs.map((r) => [k(r), r]));
  const onlyOurs = [...a.keys()].filter((x) => !b.has(x));
  const onlyTheirs = [...b.keys()].filter((x) => !a.has(x));
  const different = [...a.keys()].filter((x) => b.has(x) && cols.some((c) => !same(a.get(x)![c], b.get(x)![c])));
  return { onlyOurs, onlyTheirs, different, a, b };
}
const same = (x: number | null | undefined, y: number | null | undefined) =>
  x == null || y == null ? x == null && y == null : Math.abs(x - y) < 1e-4 * Math.max(1, Math.abs(y));

/** Tables that Gadgetbridge also fills from outside the FIT files (battery status sent by the band while connected). */
const ALSO_FROM_ELSEWHERE = new Set<ServerTable>(["BATTERY_LEVEL"]);

describe.skipIf(!GB_EXPORT)("conversion of a real Gadgetbridge export into the server format", () => {
  it("produces the same rows Gadgetbridge stored from the same FIT files, for every pairing of the band", async () => {
    const exp = await loadGbExport(GB_EXPORT);
    const report: string[] = [];
    let bad = 0;
    let compared = 0;
    for (const [folder, files] of exp.fit) {
      // Gadgetbridge keeps a band's files in a folder named after its Bluetooth address, which on a
      // vívosmart 5 changes at every pairing: each pairing is a separate device in its database
      const dev = oo1All(exp.db, "SELECT _id FROM DEVICE WHERE IDENTIFIER = ? AND MANUFACTURER = 'Garmin'", [folder])[0]?._id as number | undefined;
      const rowsOf = (table: ServerTable) =>
        dev == null ? [] : (oo1All(exp.db, `SELECT ${SERVER_TABLES[table].cols.map((c) => `"${c}"`).join(",")} FROM "${table}" WHERE DEVICE_ID = ?`, [dev]) as Row[]);
      const tables = Object.keys(SERVER_TABLES) as ServerTable[];
      if (dev == null || tables.every((t) => rowsOf(t).length === 0)) {
        report.push(`${folder}: ${files.length} file, nessun dato in Gadgetbridge per questa associazione (dispositivo rimosso?): saltata`);
        continue;
      }
      compared++;
      const { rows, device, errors } = fitToServerRows(files.map((f) => f.data));
      expect(errors).toEqual([]);
      expect(device.identifier).toMatch(/^\d+$/);
      report.push(`${folder} (dispositivo ${dev}, numero di serie ${device.identifier}): ${files.length} file`);
      for (const table of tables) {
        const theirs = rowsOf(table);
        const d = diffTable(table, rows[table], theirs);
        const n = d.onlyOurs.length + d.different.length + (ALSO_FROM_ELSEWHERE.has(table) ? 0 : d.onlyTheirs.length);
        bad += n;
        report.push(`  ${table}: ${rows[table].length} nostre, ${theirs.length} di Gadgetbridge` + (n ? ` — solo nostre ${d.onlyOurs.length}, solo GB ${d.onlyTheirs.length}, diverse ${d.different.length}` : " — uguali"));
        if (n) {
          const show = (keys: string[], m: Map<string, Row>) => keys.slice(0, 3).map((x) => JSON.stringify(m.get(x)));
          report.push(`     es. solo nostre ${show(d.onlyOurs, d.a)}`, `     es. solo GB ${show(d.onlyTheirs, d.b)}`, `     es. diverse ${d.different.slice(0, 3).map((x) => `${JSON.stringify(d.a.get(x))} / ${JSON.stringify(d.b.get(x))}`)}`);
        }
      }
    }
    const text = report.join("\n");
    console.log(text);
    expect(compared).toBeGreaterThan(0);
    expect(bad, text).toBe(0);
  }, 120_000);

  it("through the views, Gadgetbridge's database gives the same days as the app's import of the same files", async () => {
    const exp = await loadGbExport(GB_EXPORT);
    // the pairing with data in Gadgetbridge's database, and its user
    const [folder, files] = [...exp.fit].find(([f]) => oo1All(exp.db, "SELECT 1 FROM GARMIN_ACTIVITY_SAMPLE WHERE DEVICE_ID = (SELECT _id FROM DEVICE WHERE IDENTIFIER = ?) LIMIT 1", [f]).length)!;
    const gbUser = oo1All(exp.db, "SELECT USER_ID FROM GARMIN_ACTIVITY_SAMPLE WHERE DEVICE_ID = (SELECT _id FROM DEVICE WHERE IDENTIFIER = ?) LIMIT 1", [folder])[0].USER_ID as number;
    const gb = oo1Executor(exp.db);
    await createLocalViews(gb, { materialize: true });

    const { db: app } = await memoryDb();
    const me = await ensureDefaultUser(app);
    const dev = await addDevice(app, { user_id: me.id, name: "x" });
    for (const f of files) await importFit(app, { deviceId: dev.id, userId: me.id }, f.data);

    // whole days covered by the files (the first and last are partial in both)
    const span = oo1All(exp.db, "SELECT MIN(TIMESTAMP) AS a, MAX(TIMESTAMP) AS b FROM GARMIN_ACTIVITY_SAMPLE WHERE USER_ID = ?", [gbUser])[0];
    const from = addDays(startOfDay(span.a as number), 1);
    const to = startOfDay(span.b as number);
    const a = await loadRange(app, me.id, from, to);
    const b = await loadRange(gb, gbUser, from, to);
    const days = a.days.map((d) => new Date(d * 1000).toLocaleDateString("it-IT"));
    console.log(days.map((d, i) => `${d}: passi ${a.totals[i].steps} / ${b.totals[i].steps}, kcal ${a.totals[i].calories} / ${b.totals[i].calories}, m ${a.totals[i].distance_m} / ${b.totals[i].distance_m}, min attivi ${a.totals[i].active_minutes} / ${b.totals[i].active_minutes}`).join("\n"));
    // steps and active calories: the same. Distance and active minutes can be lower in Gadgetbridge's
    // format: the band writes the day's last totals in the sample at midnight, and the next file,
    // starting at midnight with a sample without counters, replaces that row (insertOrReplace) with
    // one where they are -1. Our importer keeps them. Neither is compared between people.
    expect(b.totals.map((t) => [t.steps, t.calories])).toEqual(a.totals.map((t) => [t.steps, t.calories]));
    b.totals.forEach((t, i) => expect(t.distance_m).toBeLessThanOrEqual(a.totals[i].distance_m + 1e-6));
    expect(b.stressByLevel).toEqual(a.stressByLevel);
    expect(b.hrHours).toEqual(a.hrHours);
    // Gadgetbridge stores respiration as a 32-bit float: equal up to rounding
    for (const metric of COMPARE_METRICS) {
      const va = userDailyValues(metric, a);
      userDailyValues(metric, b).forEach((v, i) => (v == null || va[i] == null ? expect(v, metric).toBe(va[i]) : expect(v, metric).toBeCloseTo(va[i]!, 5)));
    }
  }, 120_000);
});
