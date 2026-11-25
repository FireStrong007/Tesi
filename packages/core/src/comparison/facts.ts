/**
 * The comparison from each person's daily summaries (DayFacts: steps, sleep, stress, … of one day),
 * computed once with loadRange (the same rules as the user's own charts) and kept in memory: the
 * server rebuilds them when a new copy of the research data arrives and answers every request from
 * them. They are small (a few numbers per person and day) and plain data (they cross a worker
 * thread as they are).
 */
import { addDays, startOfDay } from "../db/queries";
import type { SqlExecutor } from "../db/sql";
import { loadRange } from "../range-data";
import type { ComparableStanding } from "./aggregate";
import { CohortSource, daysOf } from "./cohort";
import { factsFromRange, metricValue, type DayFacts } from "./daily-values";
import type { CompareMetric, ComparisonQuery } from "./types";

export interface PersonFacts {
  /** stable identity (participant.name) */
  key: string;
  /** participant.id in its database */
  id: number;
  /** local day starts, ascending, and the facts of each */
  days: number[];
  facts: DayFacts[];
}

/** First day with any data of a person (app tables), or null without data. */
export async function firstDataDay(db: SqlExecutor, id: number): Promise<number | null> {
  const [r] = await db.all<{ t: number | null }>(
    `SELECT min(t) AS t FROM (
       SELECT min(timestamp) AS t FROM activity_sample WHERE user_id = ?1
       UNION ALL SELECT min(start) FROM sleep_session WHERE user_id = ?1
       UNION ALL SELECT min(timestamp) FROM stress_sample WHERE user_id = ?1
       UNION ALL SELECT min(timestamp) FROM resting_hr_sample WHERE user_id = ?1)`,
    [id],
  );
  return r?.t == null ? null : startOfDay(r.t);
}

/** One person's daily facts from their first day of data to today (loadRange: the app's rules). */
export async function personFacts(db: SqlExecutor, key: string, id: number, now: number): Promise<PersonFacts> {
  const from = await firstDataDay(db, id);
  const to = addDays(startOfDay(now), 1);
  if (from == null || from >= to) return { key, id, days: [], facts: [] };
  const r = await loadRange(db, id, from, to);
  return { key, id, days: r.days, facts: r.days.map((_, i) => factsFromRange(r, i)) };
}

/** The comparison over people's daily facts; never returns one person's values. */
export class FactsComparisonSource extends CohortSource {
  readonly sample = false;
  private byKey = new Map<string, Map<number, DayFacts>>();

  constructor(
    readonly people: PersonFacts[],
    now?: () => number,
    minUsers?: number,
  ) {
    super(now, minUsers);
    for (const p of people) this.byKey.set(p.key, new Map(p.days.map((d, i) => [d, p.facts[i]])));
  }

  private valuesFor(key: string, metric: CompareMetric, days: number[]) {
    const m = this.byKey.get(key);
    return days.map((d) => metricValue(metric, m?.get(d) ?? null));
  }

  protected async valuesOf(metric: CompareMetric, days: number[], query: ComparisonQuery) {
    return this.people.filter((p) => p.key !== query.excludeUserId).map((p) => this.valuesFor(p.key, metric, days));
  }

  /**
   * Where `key` stands among the others for [from, to), over the comparable days only
   * (CohortSource.comparableStanding): their own values come from the same facts as the others'
   * (never sent by the client).
   */
  async standingOf(metric: CompareMetric, from: number, to: number, key: string): Promise<ComparableStanding> {
    return this.comparableStanding(metric, from, to, this.valuesFor(key, metric, daysOf(from, to)), { excludeUserId: key });
  }
}
