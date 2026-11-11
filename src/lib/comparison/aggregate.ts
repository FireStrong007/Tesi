import { stats } from "../metrics";

/** Below this many users a day's average is not shown (too few people, and too revealing). */
export const MIN_USERS = 5;

/** Mean of the users' values for one day; null values (no valid data) are not counted. */
export function averageOfUsers(values: (number | null | undefined)[], minUsers = MIN_USERS): { mean: number | null; n: number } {
  const valid = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return { mean: valid.length >= minUsers ? stats(valid).avg : null, n: valid.length };
}

export interface PeriodSummary {
  /** the user's average over the days with their data; null if they have none */
  mine: number | null;
  /** the others' average over the same days (or over all days when the user has no data) */
  others: number | null;
  /** (mine - others) / others, when both exist */
  diff: number | null;
}

/** Period summary: the others' average is taken only over the days where the user has data too. */
export function summarizePeriod(mine: (number | null)[], others: (number | null)[]): PeriodSummary {
  const both = mine.map((m, i) => (m != null && others[i] != null ? i : -1)).filter((i) => i >= 0);
  const myDays = mine.filter((m): m is number => m != null);
  const avg = (xs: number[]) => stats(xs).avg;
  const m = avg(myDays);
  const o = myDays.length ? avg(both.map((i) => others[i]!)) : avg(others.filter((v): v is number => v != null));
  return { mine: m, others: o, diff: m != null && o ? (m - o) / o : null };
}
