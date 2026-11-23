import { MIN_VALID_DAYS } from "../metrics";

/** Below this many users nothing about the others is shown (too few people, and too revealing). */
export const MIN_USERS = 5;

export interface Distribution {
  /** 50th percentile of the users' values; null when fewer than MIN_USERS contributed */
  median: number | null;
  /** 25th and 75th percentile: half of the users are in between */
  p25: number | null;
  p75: number | null;
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
  if (valid.length < minUsers) return { median: null, p25: null, p75: null, n: valid.length };
  return { median: quantile(valid, 0.5), p25: quantile(valid, 0.25), p75: quantile(valid, 0.75), n: valid.length };
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

export type Position = "below" | "within" | "above";

/** Inside the others' central half (25th–75th percentile) is "nella norma". */
export const positionOf = (percentile: number): Position => (percentile < 25 ? "below" : percentile > 75 ? "above" : "within");

const POSITION_TEXT: Record<Position, string> = { below: "sotto la norma", within: "nella norma", above: "sopra la norma" };

function shareText(percentile: number) {
  const p = Math.round(percentile);
  if (p <= 0) return "Meno di tutti gli altri utenti";
  if (p >= 100) return "Più di tutti gli altri utenti";
  return `Più di ${p} ${p === 1 ? "utente" : "utenti"} su 100`;
}

export interface SummaryInput {
  /** e.g. "Ultimi 30 giorni" */
  span: string;
  /** the user's value for the period (mean of their valid days), null without data */
  mine: number | null;
  /** the user's valid days in the period */
  myDays: number;
  standing: PeriodStanding;
  /** a value with its unit / a bare value */
  text: (v: number) => string;
  fmt: (v: number) => string;
}

/**
 * The summary line under the chart. The judgement is between people: the user's period value
 * against the other users' period values, e.g. "Ultimi 30 giorni: 4.120 passi/giorno, nella norma.
 * Più di 35 utenti su 100 (mediana degli altri 8.667)". It needs MIN_VALID_DAYS valid days.
 */
export function summarySentence({ span, mine, myDays, standing, text, fmt }: SummaryInput): string {
  const others = standing.median != null ? `mediana degli altri ${fmt(standing.median)}` : null;
  if (myDays < MIN_VALID_DAYS || mine == null) {
    const head = mine != null ? text(mine) : others ?? "nessun dato";
    return `${span}: ${head}. Servono almeno ${MIN_VALID_DAYS} giorni di dati per il confronto (ne hai ${myDays})`;
  }
  if (standing.percentile == null || !others) return `${span}: ${text(mine)}. Troppo pochi utenti per un confronto`;
  return `${span}: ${text(mine)}, ${POSITION_TEXT[positionOf(standing.percentile)]}. ${shareText(standing.percentile)} (${others})`;
}
