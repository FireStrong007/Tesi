/**
 * Every participant's daily facts from one copy of the research database (core's
 * FactsComparisonSource answers the comparison from them). The copy is never written: it is
 * ATTACHed read-only (mode=ro&immutable=1) to an in-memory working database, where the app's
 * tables are built as TEMP tables by core's adapter and loadRange runs on them.
 * Runs in a worker thread (worker.ts) so that the server keeps answering meanwhile.
 */
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { createAppTables } from "@bridge/core/adapters";
import { personFacts, type PersonFacts } from "@bridge/core/comparison/facts";
import type { AppId } from "@bridge/core/datasets";
import { executor } from "../sqlite";

export interface BuildStats {
  participants: number;
  /** participant-days with facts */
  days: number;
  ms: number;
  /** of which building the app's tables (the rest: each person's loadRange) */
  tablesMs: number;
  /** process memory (resident set size) before, at its highest (sampled at each step) and after, MB */
  rssMb: { before: number; peak: number; after: number };
}

export interface BuildResult {
  people: PersonFacts[];
  stats: BuildStats;
}

const mb = () => Math.round(process.memoryUsage().rss / 1048576);

export async function buildFacts(file: string, app: AppId, nowSec: number): Promise<BuildResult> {
  const t0 = Date.now();
  const before = mb();
  let peak = before;
  const sample = () => (peak = Math.max(peak, mb()));
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  const work = new DatabaseSync(":memory:");
  let result: BuildResult;
  let tablesMs = 0;
  try {
    work.prepare("ATTACH DATABASE ? AS src").run(url.href);
    const db = executor(work);
    // the app's tables as TEMP tables of the working database, from the attached copy
    await createAppTables(db, app, { materialize: true });
    tablesMs = Date.now() - t0;
    sample();
    const people: PersonFacts[] = [];
    for (const p of work.prepare("SELECT id, name FROM src.participant ORDER BY id").all() as { id: number; name: string }[]) {
      people.push(await personFacts(db, p.name, p.id, nowSec));
      sample();
    }
    result = {
      people,
      stats: { participants: people.length, days: people.reduce((s, p) => s + p.days.length, 0), ms: 0, tablesMs: 0, rssMb: { before, peak, after: 0 } },
    };
  } finally {
    // the working database and its TEMP tables are freed here
    work.close();
  }
  result.stats.ms = Date.now() - t0;
  result.stats.tablesMs = tablesMs;
  result.stats.rssMb = { before, peak: Math.max(peak, mb()), after: mb() };
  return result;
}
