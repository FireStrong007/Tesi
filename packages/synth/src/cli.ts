/**
 * npm run gen:synthetic [-- --out data --days 28 --now 2026-11-20T12:00:00 --cohort 100]
 * Writes data/synthetic-garmin.db and data/synthetic-gima.db: made-up participants with the real
 * servers' schemas, for development without the real databases (data/ is not in git). --cohort N
 * adds N Garmin participants with the demo cohort's personas (for the comparison with the others).
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { cohortParticipants, defaultGarminParticipants, writeGarminDb } from "./garmin-db";
import { defaultGimaParticipants, writeGimaDb } from "./gima-db";

const { values } = parseArgs({ options: { out: { type: "string", default: "data" }, days: { type: "string", default: "28" }, now: { type: "string" }, cohort: { type: "string", default: "0" } } });
const base = process.env.INIT_CWD ?? process.cwd();
const out = resolve(base, values.out!);
const days = Number(values.days);
const now = values.now ? new Date(values.now) : new Date();
const cohort = Number(values.cohort);
if (!Number.isFinite(days) || days < 1 || Number.isNaN(now.getTime()) || !Number.isInteger(cohort) || cohort < 0) throw new Error("Uso: --days <numero> --now <data ISO> --cohort <numero>");
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const garmin = [...defaultGarminParticipants(days), ...cohortParticipants(cohort, days)];
writeGarminDb(resolve(out, "synthetic-garmin.db"), { now, participants: garmin });
writeGimaDb(resolve(out, "synthetic-gima.db"), { now, participants: defaultGimaParticipants(Math.min(days, 21)) });
console.log(`Database sintetici scritti in ${out} (synthetic-garmin.db, synthetic-gima.db) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const until = now.toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "short", timeStyle: "short" });
console.log(`synthetic-garmin.db: ${garmin.length} partecipanti (${garmin.length - cohort} predefiniti${cohort ? ` + ${cohort} della coorte` : ""}), dati fino al ${until} (Europe/Rome)`);
// with the default participants alone most days have fewer than 5 others: the comparison needs a cohort
if (cohort < 10) console.log("Per provare «Confronta» servono più partecipanti: npm run gen:synthetic -- --cohort 100");
