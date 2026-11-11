/**
 * Entry point for the UI: the only place that decides where comparison data comes from.
 * When the server exists, return its HTTP client here instead of the demo cohort.
 */
import { DemoComparisonSource } from "./demo-source";
import type { ComparisonSource } from "./types";

export type { CompareMetric, ComparisonSource, DailyAverage } from "./types";
export { MIN_USERS, summarizePeriod } from "./aggregate";
export { userDailyValues } from "./daily-values";

let source: ComparisonSource | null = null;

export function getComparisonSource(): ComparisonSource {
  source ??= new DemoComparisonSource();
  return source;
}
