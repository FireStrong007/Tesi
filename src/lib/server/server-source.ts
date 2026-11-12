/**
 * The comparison computed on the research server's data: the same ComparisonSource contract and
 * the same rules as the app (loadRange through the views, daily-values, cohort), over the
 * participants of one or more server databases. Meant to run on the server (Node): the app only
 * ever receives the aggregates.
 */
import { CohortSource } from "../comparison/cohort";
import { userDailyValues } from "../comparison/daily-values";
import type { CompareMetric, ComparisonQuery } from "../comparison/types";
import { addDays } from "../db/repo";
import type { SqlExecutor } from "../db/sql";
import { loadRange, type RangeData } from "../range-data";
import { SERVER_TABLES, type Row, type ServerTable } from "./fit-to-server";
import { createLocalViews } from "./views";

/** One person on the server: the database holding their data and their id in it. */
export interface Participant {
  /** stable identity across databases (participant.name, unique) */
  key: string;
  db: SqlExecutor;
  id: number;
}

/**
 * The participants of any number of server databases (one with everyone, one per participant, or
 * anything in between). The views are created on each connection. A participant found in two
 * databases is an error: they would be counted twice.
 */
export async function participantsOf(dbs: SqlExecutor[], opts: { materialize?: boolean; timeZone?: string } = {}): Promise<Participant[]> {
  const out: Participant[] = [];
  const seen = new Map<string, number>();
  for (const [i, db] of dbs.entries()) {
    await createLocalViews(db, opts);
    for (const p of await db.all<{ id: number; name: string }>("SELECT id, name FROM participant ORDER BY id")) {
      if (seen.has(p.name)) throw new Error(`Il partecipante «${p.name}» compare in due database (${seen.get(p.name)} e ${i}): verrebbe contato due volte`);
      seen.set(p.name, i);
      out.push({ key: p.name, db, id: p.id });
    }
  }
  return out;
}

/**
 * A snapshot of the server's data: opened on materialized copies of the app's tables (see
 * createLocalViews), with each participant's period computed once and reused for every metric.
 * Open a new one (or call refresh) after new data is uploaded.
 */
export class ServerComparisonSource extends CohortSource {
  readonly sample = false;
  private ranges = new Map<string, Promise<RangeData>>();

  constructor(
    private participants: Participant[],
    private dbs: SqlExecutor[] = [],
    now?: () => number,
  ) {
    super(now);
  }

  static async open(dbs: SqlExecutor[], now?: () => number) {
    return new ServerComparisonSource(await participantsOf(dbs, { materialize: true }), dbs, now);
  }

  /** Rebuilds the snapshot (after uploads). */
  async refresh() {
    this.participants = await participantsOf(this.dbs, { materialize: true });
    this.ranges.clear();
  }

  /** each participant's days computed exactly like the app computes the user's (loadRange) */
  protected async valuesOf(metric: CompareMetric, days: number[], query: ComparisonQuery) {
    const others = this.participants.filter((p) => p.key !== query.excludeUserId);
    const from = days[0];
    const to = addDays(days[days.length - 1], 1);
    const out: (number | null)[][] = [];
    for (const p of others) {
      const key = `${p.key}:${from}:${to}`;
      let r = this.ranges.get(key);
      if (!r) this.ranges.set(key, (r = loadRange(p.db, p.id, from, to)));
      out.push(userDailyValues(metric, await r));
    }
    return out;
  }
}

/**
 * Stores converted rows (fit-to-server) for one participant's band, replacing rows with the same
 * key like Gadgetbridge does. `deviceId` is the server's device row of that band.
 */
export async function insertServerRows(db: SqlExecutor, participantId: number, deviceId: number, rows: Partial<Record<ServerTable, Row[]>>) {
  const statements = [];
  for (const [table, list] of Object.entries(rows) as [ServerTable, Row[]][]) {
    const cols = SERVER_TABLES[table].cols;
    const sql = `INSERT OR REPLACE INTO "${table}" (USER_ID, DEVICE_ID, ${cols.map((c) => `"${c}"`).join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})`;
    for (const r of list) statements.push({ sql, params: [participantId, deviceId, ...cols.map((c) => r[c] ?? null)] });
  }
  await db.batch(statements);
}
