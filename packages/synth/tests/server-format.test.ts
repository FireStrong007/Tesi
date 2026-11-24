/**
 * Our FIT -> server rows conversion (fit-to-server, used by the synthetic databases) against what
 * Gadgetbridge stored from the same FIT files, on a real export (GB_EXPORT; skipped without it).
 */
import { describe, expect, it } from "vitest";
import { oo1All } from "@bridge/core/db/sql";
import { GB_EXPORT, loadGbExport } from "../src/gb-export";
import { SERVER_TABLES, fitToServerRows, type Row, type ServerTable } from "../src/server/fit-to-server";
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
});
