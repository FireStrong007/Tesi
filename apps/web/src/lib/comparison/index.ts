/**
 * Entry point for the UI: the only place that decides where the comparison with the other
 * participants comes from: our server (http-source.ts).
 */
import { HttpComparisonSource } from "./http-source";

export type { CompareMetric, ComparisonSource, DailyDistribution } from "@bridge/core/comparison/types";
export type { PeriodStanding } from "@bridge/core/comparison/aggregate";
export { MIN_USERS, NOT_ENOUGH_PARTICIPANTS, summarySentence } from "@bridge/core/comparison/aggregate";
export { WEEKLY_METRICS, periodValue, userDailyValues, weeklyTotal, weeksCovering } from "@bridge/core/comparison/daily-values";
export type { ServerStanding } from "./http-source";

/** «Confronta» is shown (the server computes the comparison) */
export const COMPARE_AVAILABLE = true;

let source: HttpComparisonSource | null = null;
export function getComparisonSource(): HttpComparisonSource {
  source ??= new HttpComparisonSource();
  return source;
}
