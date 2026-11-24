/**
 * Time zone of the study: every participant's days are Italian days (decided with the professor),
 * in the browser, on the server and in the tests, whatever the device's or the process's own zone.
 * Every day boundary, hour and calendar date of the app comes from here (never from Date's local
 * getters); the views on the server data split the band's day counters with the same zone.
 */
export const STUDY_TIME_ZONE = "Europe/Rome";

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (timeZone: string) => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timeZone, f);
  }
  return f;
};

/** UTC offset (seconds) of a time zone at a moment. */
export function zoneOffset(timeZone: string, ts: number): number {
  const parts = formatter(timeZone)
    .formatToParts(new Date(ts * 1000))
    .reduce<Record<string, number>>((o, p) => (p.type === "literal" ? o : { ...o, [p.type]: Number(p.value) }), {});
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000 - Math.floor(ts);
}

const transitions = new Map<string, [number, number][]>();
/**
 * The zone's offset changes between two years: [from, offset] with the offset valid from that
 * moment. Computed once per zone and range (about 11 000 Intl calls for 30 years), then reused.
 */
export function zoneTransitions(timeZone: string, fromYear = 2015, toYear = 2045): [number, number][] {
  const key = `${timeZone}:${fromYear}:${toYear}`;
  let t = transitions.get(key);
  if (!t) transitions.set(key, (t = computeTransitions(timeZone, fromYear, toYear)));
  return t.map(([a, b]) => [a, b]);
}

function computeTransitions(timeZone: string, fromYear: number, toYear: number): [number, number][] {
  const start = Date.UTC(fromYear, 0, 1) / 1000;
  const end = Date.UTC(toYear, 0, 1) / 1000;
  const out: [number, number][] = [[start, zoneOffset(timeZone, start)]];
  for (let t = start + 86400; t <= end; t += 86400) {
    const o = zoneOffset(timeZone, t);
    if (o === out[out.length - 1][1]) continue;
    // the change happened within the last day: find the hour
    let lo = t - 86400;
    let hi = t;
    while (hi - lo > 60) {
      const mid = Math.floor((lo + hi) / 120) * 60;
      if (zoneOffset(timeZone, mid) === o) hi = mid;
      else lo = mid;
    }
    out.push([hi, o]);
  }
  return out;
}

// ------------------------------------------------------------------ the study's calendar

// offsets change only on hour boundaries (Europe/Rome: 01:00 UTC): one Intl call per hour, cached
const offsets = new Map<number, number>();
/** UTC offset (seconds) of the study's zone at a moment */
export function studyOffset(ts: number): number {
  const hour = Math.floor(ts / 3600);
  let o = offsets.get(hour);
  if (o === undefined) {
    if (offsets.size > 200_000) offsets.clear();
    o = zoneOffset(STUDY_TIME_ZONE, hour * 3600);
    offsets.set(hour, o);
  }
  return o;
}

export interface LocalParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

/** Calendar date and time of a moment (unix seconds) in the study's zone. */
export function localParts(ts: number): LocalParts {
  const d = new Date((ts + studyOffset(ts)) * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), weekday: d.getUTCDay() };
}

/** The moment (unix seconds) of a wall-clock time in the study's zone; out-of-range values roll over like Date.UTC. */
export function zonedTime(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  const guess = wall - studyOffset(wall);
  return wall - studyOffset(guess);
}

/** midnight that starts the study's day containing ts */
export const startOfDay = (ts: number) => {
  const p = localParts(ts);
  return zonedTime(p.year, p.month, p.day);
};
/** midnight n days after the day of dayStart (23 or 25 hours across daylight saving changes) */
export const addDays = (dayStart: number, n: number) => {
  const p = localParts(dayStart);
  return zonedTime(p.year, p.month, p.day + n);
};
/** midnight of the 1st of the month `n` months after the one containing ts */
export const monthStart = (ts: number, n = 0) => {
  const p = localParts(ts);
  return zonedTime(p.year, p.month + n, 1);
};
/** Monday 00:00 of the Monday–Sunday week containing ts */
export const weekStart = (ts: number) => {
  const day = startOfDay(ts);
  return addDays(day, -((localParts(day).weekday + 6) % 7));
};
const pad = (n: number) => String(n).padStart(2, "0");
/** "2026-11-24" */
export const dayKey = (ts: number) => {
  const p = localParts(ts);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};
/** the moment of a "YYYY-MM-DD" day's midnight */
export const fromDayKey = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return zonedTime(y, m, d);
};
