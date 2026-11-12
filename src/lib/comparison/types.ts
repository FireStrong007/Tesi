/**
 * Comparison with other users: the contract between the charts and whatever provides the other
 * users' values (today a synthetic demo cohort, later an HTTP client towards the server).
 */
import type { Distribution, PeriodStanding } from "./aggregate";

export const COMPARE_METRICS = ["steps", "calories", "sleep", "resting_hr", "stress", "body_battery", "spo2", "respiration", "hrv", "intensity"] as const;
export type CompareMetric = (typeof COMPARE_METRICS)[number];

/**
 * The other users' values on one day: median, 25th and 75th percentile and how many users had valid
 * data. Median and percentiles are null when fewer than MIN_USERS contributed.
 */
export interface DailyDistribution extends Distribution {
  /** local start of day (unix seconds) */
  day: number;
}

export interface ComparisonQuery {
  /** the current user, never part of the distribution */
  excludeUserId?: string;
  /** the asking profile is the demo: its values must never be counted among the others nor stored */
  isDemo?: boolean;
}

/**
 * What the charts may ask about the other users: only aggregates (median, percentiles, n, a
 * percentile rank), never one person's values; nothing below MIN_USERS people. The demo profile
 * is never part of it (repo.shareableUsers).
 */
export interface ComparisonSource {
  /** true while the values are example data (the UI says so) */
  readonly sample: boolean;
  /** one entry per local day in [from, to) */
  dailyDistribution(metric: CompareMetric, from: number, to: number, query?: ComparisonQuery): Promise<DailyDistribution[]>;
  /** one entry per Monday–Sunday week covering [from, to), on weekly totals (WEEKLY_METRICS) */
  weeklyDistribution(metric: CompareMetric, from: number, to: number, query?: ComparisonQuery): Promise<DailyDistribution[]>;
  /**
   * Between people: every other user's period value (daily-values.periodValue, only users with
   * MIN_VALID_DAYS valid days), their median and central half, and the percentile rank of `mine`.
   */
  periodStanding(metric: CompareMetric, from: number, to: number, mine: number | null, query?: ComparisonQuery): Promise<PeriodStanding>;
}
