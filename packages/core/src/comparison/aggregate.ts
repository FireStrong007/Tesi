import { MIN_VALID_DAYS } from "../metrics";
import type { CompareMetric } from "./types";

/**
 * Below this many people nothing about the others is shown (too few people, and too revealing).
 * The server can raise it (COMPARE_MIN_PARTICIPANTS); this is the default.
 */
export const MIN_USERS = 5;

export interface Distribution {
  /** 50th percentile of the users' values; null when fewer than MIN_USERS contributed */
  median: number | null;
  /** 25th and 75th percentile: half of the users are in between */
  p25: number | null;
  p75: number | null;
  /** arithmetic mean; null like the median */
  mean: number | null;
  /** users with valid data */
  n: number;
}

/** Percentile q (0..1) of sorted values, interpolating between the closest ranks (R-7 / numpy default). */
export function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const validSorted = (values: (number | null | undefined)[]) => values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);

/** Median and central 50% of the users' values; null values (no valid data) are not counted. */
export function distributionOfUsers(values: (number | null | undefined)[], minUsers = MIN_USERS): Distribution {
  const valid = validSorted(values);
  if (valid.length < minUsers) return { median: null, p25: null, p75: null, mean: null, n: valid.length };
  const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
  return { median: quantile(valid, 0.5), p25: quantile(valid, 0.25), p75: quantile(valid, 0.75), mean, n: valid.length };
}

/** Where one value stands among the other users' values for the whole period. */
export interface PeriodStanding extends Distribution {
  /** share of the others below the value (ties count half), 0–100; null without a value or with fewer than MIN_USERS */
  percentile: number | null;
}

/** Percentile rank of `mine` among the others' period values (one value per person). */
export function standingAmong(others: (number | null | undefined)[], mine: number | null, minUsers = MIN_USERS): PeriodStanding {
  const d = distributionOfUsers(others, minUsers);
  if (d.median == null || mine == null) return { ...d, percentile: null };
  const valid = validSorted(others);
  const below = valid.filter((v) => v < mine).length;
  const ties = valid.filter((v) => v === mine).length;
  return { ...d, percentile: ((below + ties / 2) / valid.length) * 100 };
}

/** what the app says when fewer than the minimum of other participants have data */
export const NOT_ENOUGH_PARTICIPANTS = "Non ci sono abbastanza partecipanti per un confronto";

export type Position = "below" | "within" | "above";

/** Inside the others' central half (25th–75th percentile) is "nella norma". */
export const positionOf = (percentile: number): Position => (percentile < 25 ? "below" : percentile > 75 ? "above" : "within");

const POSITION_TEXT: Record<Position, string> = { below: "sotto la norma", within: "nella norma", above: "sopra la norma" };

/**
 * How each metric is said in the sentences of the comparison: "Fai più passi di circa 40
 * partecipanti su 100", "Nessun altro partecipante ha dati sul sonno in questo periodo".
 */
export const METRIC_WORDS: Record<CompareMetric, { more: string; less: string; about: string }> = {
  steps: { more: "Fai più passi", less: "Fai meno passi", about: "sui passi" },
  calories: { more: "Bruci più calorie attive", less: "Bruci meno calorie attive", about: "sulle calorie attive" },
  sleep: { more: "Dormi più a lungo", less: "Dormi meno", about: "sul sonno" },
  resting_hr: { more: "Hai il battito a riposo più alto", less: "Hai il battito a riposo più basso", about: "sul battito a riposo" },
  stress: { more: "Hai uno stress medio più alto", less: "Hai uno stress medio più basso", about: "sullo stress" },
  body_battery: { more: "Hai una Body Battery massima più alta", less: "Hai una Body Battery massima più bassa", about: "sulla Body Battery" },
  spo2: { more: "Hai una SpO₂ media più alta", less: "Hai una SpO₂ media più bassa", about: "sulla SpO₂" },
  respiration: { more: "Respiri più spesso", less: "Respiri meno spesso", about: "sulla respirazione" },
  hrv: { more: "Hai una HRV più alta", less: "Hai una HRV più bassa", about: "sulla HRV" },
  intensity: { more: "Hai più minuti di intensità", less: "Hai meno minuti di intensità", about: "sui minuti di intensità" },
};

/** "Nessun altro partecipante ha dati sul sonno in questo periodo" (or day, week) */
export function noOthersMessage(metric: CompareMetric, scope: "periodo" | "giorno" | "settimana"): string {
  const where = scope === "settimana" ? "in questa settimana" : `in questo ${scope}`;
  return `Nessun altro partecipante ha dati ${METRIC_WORDS[metric].about} ${where}`;
}

/** "Fai più passi di circa 40 partecipanti su 100" */
export function rankSentence(metric: CompareMetric, percentile: number): string {
  const w = METRIC_WORDS[metric];
  const p = Math.round(percentile);
  if (p <= 0) return `${w.less} di tutti gli altri partecipanti`;
  if (p >= 100) return `${w.more} di tutti gli altri partecipanti`;
  return `${w.more} di circa ${p} ${p === 1 ? "partecipante" : "partecipanti"} su 100`;
}

/**
 * The standing over the comparable part of a period: the days (weeks, for weekly metrics) already
 * over on which the others' distribution exists (at least the minimum of other participants with
 * data). The participant's value and the others' are computed over those days only.
 */
export interface ComparableStanding extends PeriodStanding {
  /** the asking participant's value over the comparable days and their valid days among them */
  mine: { value: number | null; days: number };
  /** how many comparable days (or weeks) the period has */
  comparable: { count: number; unit: "day" | "week" };
  /** no other participant has any data for the metric in the period */
  noOthers: boolean;
}

export interface SummaryInput {
  metric: CompareMetric;
  /** e.g. "Novembre" */
  span: string;
  standing: ComparableStanding;
  /** a value with its unit / a bare value */
  text: (v: number) => string;
  fmt: (v: number) => string;
}

const comparableText = ({ count, unit }: ComparableStanding["comparable"]) =>
  unit === "week" ? `${count} ${count === 1 ? "settimana confrontabile" : "settimane confrontabili"}` : `${count} ${count === 1 ? "giorno confrontabile" : "giorni confrontabili"}`;

/**
 * The summary line under the chart. The judgement is between people, over the comparable days
 * only (ComparableStanding), and the line says how many they are, e.g. "Novembre, su 18 giorni
 * confrontabili: 4.120 passi/giorno, nella norma. Fai più passi di circa 35 partecipanti su 100
 * (mediana degli altri 8.667)". It needs MIN_VALID_DAYS valid days of the participant among the
 * comparable ones (today does not count until it is over: daily-values.periodValue).
 */
export function summarySentence({ metric, span, standing, text, fmt }: SummaryInput): string {
  const { mine, comparable } = standing;
  if (standing.noOthers) return noOthersMessage(metric, "periodo");
  if (comparable.count === 0) return `${span}: ${NOT_ENOUGH_PARTICIPANTS} in ${comparable.unit === "week" ? "nessuna settimana" : "nessun giorno"} del periodo`;
  const head = `${span}, su ${comparableText(comparable)}`;
  if (mine.days < MIN_VALID_DAYS || mine.value == null)
    return `${head}: ${mine.value != null ? text(mine.value) : "nessun tuo dato"}. Servono almeno ${MIN_VALID_DAYS} giorni con i tuoi dati tra quelli confrontabili (ne hai ${mine.days})`;
  if (standing.percentile == null || standing.median == null) return `${head}: ${text(mine.value)}. ${NOT_ENOUGH_PARTICIPANTS}`;
  return `${head}: ${text(mine.value)}, ${POSITION_TEXT[positionOf(standing.percentile)]}. ${rankSentence(metric, standing.percentile)} (mediana degli altri ${fmt(standing.median)})`;
}
