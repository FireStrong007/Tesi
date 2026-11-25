/**
 * The comparison computed on the research server's data: the same ComparisonSource contract and
 * the same rules as the app (loadRange through the views, daily-values, cohort), over the
 * participants of one or more server databases. Meant to run on the server (Node): the app only
 * ever receives the aggregates.
 */
import { FactsComparisonSource, personFacts, type PersonFacts } from "../comparison/facts";
import type { SqlExecutor } from "../db/sql";
import { STUDY_TIME_ZONE } from "../time-zone";
import { SERVER_TABLES, type Row, type ServerTable } from "./schema";
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
 * The comparison on the server's participants: each one's daily facts computed once with loadRange
 * through the views (the app's rules), then FactsComparisonSource answers from them. Open a new one
 * after new data is uploaded (the server does it when its data copy changes).
 */
export class ServerComparisonSource extends FactsComparisonSource {
  /** Opens a snapshot over the participants of `dbs` (days in the study's time zone, whatever the process's). */
  static async open(dbs: SqlExecutor[], now: () => number = () => Math.floor(Date.now() / 1000), opts: { minUsers?: number } = {}) {
    const people = await participantsOf(dbs, { materialize: true, timeZone: STUDY_TIME_ZONE });
    const facts: PersonFacts[] = [];
    for (const p of people) facts.push(await personFacts(p.db, p.key, p.id, now()));
    return new ServerComparisonSource(facts, now, opts.minUsers);
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
