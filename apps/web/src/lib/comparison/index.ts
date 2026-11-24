/**
 * Entry point for the UI: the only place that decides where the comparison with the other
 * participants comes from. Until Fase 4 (the server's comparison) there is none: «Confronta» is
 * hidden (COMPARE_AVAILABLE) and the charts never ask.
 */
import type { ComparisonSource } from "@bridge/core/comparison/types";

export type { CompareMetric, ComparisonSource, DailyDistribution } from "@bridge/core/comparison/types";
export type { PeriodStanding } from "@bridge/core/comparison/aggregate";
export { MIN_USERS, summarySentence } from "@bridge/core/comparison/aggregate";
export { WEEKLY_METRICS, periodValue, userDailyValues, weeklyTotal, weeksCovering } from "@bridge/core/comparison/daily-values";

/** «Confronta» is shown only when the server's comparison is there (Fase 4) */
export const COMPARE_AVAILABLE = false;

export function getComparisonSource(): ComparisonSource {
  throw new Error("Il confronto con gli altri partecipanti arriva con la Fase 4");
}
