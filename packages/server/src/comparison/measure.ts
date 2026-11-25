/**
 * npm run measure:compare -- <research database> [vitabridge|heartbridge]
 * Builds the comparison cache once from a database (read-only, like the server) and reports the
 * time, the process memory and the size of the result. The database is never written.
 */
import { resolve } from "node:path";
import { isAppId } from "@bridge/core/datasets";
import { buildFacts } from "./build";

const [file, app = "vitabridge"] = process.argv.slice(2);
if (!file || !isAppId(app)) throw new Error("Uso: npm run measure:compare -- <database> [vitabridge|heartbridge]");
const base = process.env.INIT_CWD ?? process.cwd();
const r = await buildFacts(resolve(base, file), app, Math.floor(Date.now() / 1000));
const json = JSON.stringify(r.people).length;
console.log(`partecipanti: ${r.stats.participants}, giorni-persona: ${r.stats.days}`);
console.log(`tempo: ${(r.stats.ms / 1000).toFixed(1)} s (tabelle dell'app ${(r.stats.tablesMs / 1000).toFixed(1)} s, valori per persona ${((r.stats.ms - r.stats.tablesMs) / 1000).toFixed(1)} s)`);
console.log(`memoria del processo (RSS): prima ${r.stats.rssMb.before} MB, massimo ${r.stats.rssMb.peak} MB, dopo ${r.stats.rssMb.after} MB`);
console.log(`cache risultante: ${(json / 1048576).toFixed(2)} MB (JSON)`);
