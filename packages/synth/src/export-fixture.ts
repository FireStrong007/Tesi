/**
 * npx tsx packages/synth/src/export-fixture.ts data/gadgetbridge_*.zip 4 data/export-device4.json
 *
 * Extracts from a Gadgetbridge export's database only the rows of one device in the tables the
 * app's daily values need (Gadgetbridge's Garmin tables, the research server's format), as compact
 * JSON for core's verification test (packages/core/tests/export-verification.test.ts). They are a
 * person's health data: write them into data/, which git ignores, never into the repository.
 */
import { writeFileSync } from "node:fs";
import { oo1All } from "@bridge/core/db/sql";
import { SERVER_TABLES, type ServerTable } from "@bridge/core/server/schema";
import { loadGbExport } from "./gb-export";

const [zip, device, out] = process.argv.slice(2);
if (!zip || !device || !out) throw new Error("Uso: export-fixture.ts <export.zip> <DEVICE_ID> <out.json>");

const exp = await loadGbExport(zip);
const tables: Record<string, { cols: string[]; rows: (number | null)[][] }> = {};
let total = 0;
for (const table of Object.keys(SERVER_TABLES) as ServerTable[]) {
  if (table === "BATTERY_LEVEL") continue; // not used by the daily values
  const cols = [...SERVER_TABLES[table].cols];
  const rows = oo1All(exp.db, `SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${table}" WHERE DEVICE_ID = ? ORDER BY 1`, [Number(device)]).map((r) => cols.map((c) => r[c] as number | null));
  tables[table] = { cols, rows };
  total += rows.length;
}
writeFileSync(out, JSON.stringify({ source: "export di Gadgetbridge, solo le righe di un dispositivo (DEVICE_ID)", device: Number(device), tables }) + "\n");
console.log(`${total} righe di ${Object.keys(tables).length} tabelle in ${out}`);
