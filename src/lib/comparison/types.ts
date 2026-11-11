/**
 * Comparison with other users: the contract between the charts and whatever provides the
 * averages (today a synthetic demo cohort, later an HTTP client towards the server).
 */

export const COMPARE_METRICS = ["steps", "calories", "sleep", "resting_hr", "stress", "body_battery", "spo2", "respiration", "hrv", "intensity"] as const;
export type CompareMetric = (typeof COMPARE_METRICS)[number];

export interface DailyAverage {
  /** local start of day (unix seconds) */
  day: number;
  /** mean of the other users' daily values; null when fewer than MIN_USERS contributed */
  mean: number | null;
  /** users with valid data for that metric on that day */
  n: number;
}

export interface ComparisonQuery {
  /** the current user, never part of the average */
  excludeUserId?: string;
}

export interface ComparisonSource {
  /** true while the averages are example data (the UI says so) */
  readonly sample: boolean;
  /** one entry per local day in [from, to) */
  dailyAverages(metric: CompareMetric, from: number, to: number, query?: ComparisonQuery): Promise<DailyAverage[]>;
}
