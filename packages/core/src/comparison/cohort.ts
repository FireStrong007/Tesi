/**
 * The comparison rules on top of "every other person's daily values": daily and weekly
 * distributions, the period value of each person and the user's rank among them. Shared by every
 * ComparisonSource (the demo cohort, the server's participants), which only has to say where the
 * daily values come from.
 */
import { addDays, startOfDay } from "../db/queries";
import { MIN_VALID_DAYS } from "../metrics";
import { MIN_USERS, distributionOfUsers, standingAmong, type ComparableStanding, type PeriodStanding } from "./aggregate";
import { WEEKLY_METRICS, periodValue, weeklyTotal, weeksCovering } from "./daily-values";
import type { CompareMetric, ComparisonQuery, ComparisonSource, DailyDistribution } from "./types";

export function daysOf(from: number, to: number) {
  const out: number[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

export abstract class CohortSource implements ComparisonSource {
  abstract readonly sample: boolean;
  protected now: () => number;
  /** fewest people with data for any aggregate (aggregate.MIN_USERS unless configured) */
  readonly minUsers: number;

  constructor(now?: () => number, minUsers = MIN_USERS) {
    this.now = now ?? (() => Math.floor(Date.now() / 1000));
    this.minUsers = minUsers;
  }

  /**
   * Every other person's daily value of `metric` (daily-values.metricValue) over `days`: one array
   * per person, null = no valid data that day. The asking user is left out (query.excludeUserId).
   */
  protected abstract valuesOf(metric: CompareMetric, days: number[], query: ComparisonQuery): Promise<(number | null)[][]>;

  async dailyDistribution(metric: CompareMetric, from: number, to: number, query: ComparisonQuery = {}): Promise<DailyDistribution[]> {
    const days = daysOf(from, to);
    const values = await this.valuesOf(metric, days, query);
    return days.map((day, i) => ({ day, ...distributionOfUsers(values.map((v) => v[i]), this.minUsers) }));
  }

  async weeklyDistribution(metric: CompareMetric, from: number, to: number, query: ComparisonQuery = {}): Promise<DailyDistribution[]> {
    const weeks = weeksCovering(from, to);
    const days = daysOf(weeks[0].start, weeks[weeks.length - 1].end);
    const now = this.now();
    const values = await this.valuesOf(metric, days, query);
    return weeks.map((w) => ({ day: w.start, ...distributionOfUsers(values.map((v) => weeklyTotal(days, v, w, now)), this.minUsers) }));
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
    return standingAmong(perPerson, mine, this.minUsers);
  }

  /**
   * The standing over the comparable part of [from, to) (aggregate.ComparableStanding): only the
   * days already over on which the others' daily distribution exists, or, for weekly metrics, the
   * complete weeks on which the weekly one exists. `mine` are the asking participant's daily values
   * over the same days. Elsewhere there is nothing to compare with, so those days count neither for
   * the participant nor for the others.
   */
  async comparableStanding(metric: CompareMetric, from: number, to: number, mine: (number | null)[], query: ComparisonQuery = {}): Promise<ComparableStanding> {
    const days = daysOf(from, to);
    const now = this.now();
    const today = startOfDay(now);
    const values = await this.valuesOf(metric, days, query);
    const keep = days.map(() => false);
    let count = 0;
    const weekly = WEEKLY_METRICS.has(metric);
    if (weekly) {
      for (const w of weeksCovering(from, to)) {
        if (w.end > today || distributionOfUsers(values.map((v) => weeklyTotal(days, v, w, now)), this.minUsers).median == null) continue;
        count++;
        days.forEach((d, i) => (keep[i] ||= d >= w.start && d < w.end));
      }
    } else {
      days.forEach((d, i) => {
        if (d >= today || distributionOfUsers(values.map((v) => v[i]), this.minUsers).median == null) return;
        keep[i] = true;
        count++;
      });
    }
    const only = (v: (number | null)[]) => v.map((x, i) => (keep[i] ? x : null));
    const minePeriod = periodValue(metric, days, only(mine), now);
    const perPerson = values.map((v) => {
      const p = periodValue(metric, days, only(v), now);
      return p.days >= MIN_VALID_DAYS ? p.value : null;
    });
    return {
      ...standingAmong(perPerson, minePeriod.days >= MIN_VALID_DAYS ? minePeriod.value : null, this.minUsers),
      mine: minePeriod,
      comparable: { count, unit: weekly ? "week" : "day" },
      noOthers: values.every((v) => v.every((x) => x == null)),
    };
  }
}
