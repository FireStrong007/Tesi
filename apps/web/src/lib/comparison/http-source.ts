/**
 * The comparison with the other participants, computed by our server on its copy of the research
 * data (packages/server, /api/compare/*): only aggregates arrive here. The asking participant is
 * left out by the server from the session; their own period value for the standing is computed
 * there too, from the same data and with the same rules as the others'.
 */
import { MIN_USERS, type PeriodStanding } from "@bridge/core/comparison/aggregate";
import type { CompareMetric, ComparisonSource, DailyDistribution } from "@bridge/core/comparison/types";
import { apiGet } from "@/lib/api";

export type ServerStanding = PeriodStanding & { mine: { value: number | null; days: number } };

export class HttpComparisonSource implements ComparisonSource {
  readonly sample = false;
  /** the server's minimum of participants (COMPARE_MIN_PARTICIPANTS), known after the first answer */
  minParticipants = MIN_USERS;

  private q(metric: CompareMetric, from: number, to: number) {
    return `metric=${metric}&from=${from}&to=${to}`;
  }

  async dailyDistribution(metric: CompareMetric, from: number, to: number): Promise<DailyDistribution[]> {
    const r = await apiGet<{ days: DailyDistribution[]; minParticipants: number }>(`compare/daily?${this.q(metric, from, to)}`);
    this.minParticipants = r.minParticipants;
    return r.days;
  }

  async weeklyDistribution(metric: CompareMetric, from: number, to: number): Promise<DailyDistribution[]> {
    const r = await apiGet<{ weeks: DailyDistribution[]; minParticipants: number }>(`compare/weekly?${this.q(metric, from, to)}`);
    this.minParticipants = r.minParticipants;
    return r.weeks;
  }

  /** `mine` is not sent: the server computes the participant's own value from its data */
  async periodStanding(metric: CompareMetric, from: number, to: number): Promise<ServerStanding> {
    const r = await apiGet<{ standing: ServerStanding; minParticipants: number }>(`compare/standing?${this.q(metric, from, to)}`);
    this.minParticipants = r.minParticipants;
    return r.standing;
  }
}
