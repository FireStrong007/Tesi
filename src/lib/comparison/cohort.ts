/**
 * The comparison rules on top of "every other person's daily values": daily and weekly
 * distributions, the period value of each person and the user's rank among them. Shared by every
 * ComparisonSource (the demo cohort, the server's participants), which only has to say where the
 * daily values come from.
 */
import { addDays } from "../db/repo";
import { MIN_VALID_DAYS } from "../metrics";
import { distributionOfUsers, standingAmong, type PeriodStanding } from "./aggregate";
import { periodValue, weeklyTotal, weeksCovering } from "./daily-values";
import type { CompareMetric, ComparisonQuery, ComparisonSource, DailyDistribution } from "./types";

export function daysOf(from: number, to: number) {
  const out: number[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

export abstract class CohortSource implements ComparisonSource {
  abstract readonly sample: boolean;
  protected now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Every other person's daily value of `metric` (daily-values.metricValue) over `days`: one array
   * per person, null = no valid data that day. The asking user is left out (query.excludeUserId).
   */
  protected abstract valuesOf(metric: CompareMetric, days: number[], query: ComparisonQuery): Promise<(number | null)[][]>;

  async dailyDistribution(metric: CompareMetric, from: number, to: number, query: ComparisonQuery = {}): Promise<DailyDistribution[]> {
    const days = daysOf(from, to);
    const values = await this.valuesOf(metric, days, query);
    return days.map((day, i) => ({ day, ...distributionOfUsers(values.map((v) => v[i])) }));
  }

  async weeklyDistribution(metric: CompareMetric, from: number, to: number, query: ComparisonQuery = {}): Promise<DailyDistribution[]> {
    const weeks = weeksCovering(from, to);
    const days = daysOf(weeks[0].start, weeks[weeks.length - 1].end);
    const now = this.now();
    const values = await this.valuesOf(metric, days, query);
    return weeks.map((w) => ({ day: w.start, ...distributionOfUsers(values.map((v) => weeklyTotal(days, v, w, now))) }));
  }

  async periodStanding(metric: CompareMetric, from: number, to: number, mine: number | null, query: ComparisonQuery = {}): Promise<PeriodStanding> {
    const days = daysOf(from, to);
    const now = this.now();
    const values = await this.valuesOf(metric, days, query);
    // a person counts only with enough valid days, like the user
    const perPerson = values.map((v) => {
      const p = periodValue(metric, days, v, now);
      return p.days >= MIN_VALID_DAYS ? p.value : null;
    });
    return standingAmong(perPerson, mine);
  }
}
