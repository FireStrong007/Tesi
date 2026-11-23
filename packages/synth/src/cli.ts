/**
 * npm run gen:synthetic [-- --out data --days 28 --now 2026-11-20T12:00:00]
 * Writes data/synthetic-garmin.db and data/synthetic-gima.db: made-up participants with the real
 * servers' schemas, for development without the real databases (data/ is not in git).
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultGarminParticipants, writeGarminDb } from "./garmin-db";
import { defaultGimaParticipants, writeGimaDb } from "./gima-db";

const { values } = parseArgs({ options: { out: { type: "string", default: "data" }, days: { type: "string", default: "28" }, now: { type: "string" } } });
const base = process.env.INIT_CWD ?? process.cwd();
const out = resolve(base, values.out!);
const days = Number(values.days);
const now = values.now ? new Date(values.now) : new Date();
if (!Number.isFinite(days) || days < 1 || Number.isNaN(now.getTime())) throw new Error("Uso: --days <numero> --now <data ISO>");
mkdirSync(out, { recursive: true });
const t0 = Date.now();
writeGarminDb(resolve(out, "synthetic-garmin.db"), { now, participants: defaultGarminParticipants(days) });
writeGimaDb(resolve(out, "synthetic-gima.db"), { now, participants: defaultGimaParticipants(Math.min(days, 21)) });
console.log(`Database sintetici scritti in ${out} (synthetic-garmin.db, synthetic-gima.db) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
