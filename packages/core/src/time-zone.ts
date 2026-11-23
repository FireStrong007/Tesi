/**
 * Time zone of the study: every participant's days are Italian days (decided with the professor).
 * The views on the server data split the band's day counters with it, and the comparison on the
 * server only runs in a process whose local time is this zone, because loadRange groups days with
 * the process's local time.
 */
export const STUDY_TIME_ZONE = "Europe/Rome";

/** UTC offset (seconds) of a time zone at a moment. */
export function zoneOffset(timeZone: string, ts: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(ts * 1000))
    .reduce<Record<string, number>>((o, p) => (p.type === "literal" ? o : { ...o, [p.type]: Number(p.value) }), {});
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000 - ts;
}

/** The zone's offset changes between two years: [from, offset] with the offset valid from that moment. */
export function zoneTransitions(timeZone: string, fromYear = 2015, toYear = 2045): [number, number][] {
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


/** True when this process's local time (Date) follows `timeZone` over the given years. */
export function processUsesZone(timeZone: string, fromYear = 2024, toYear = 2031): boolean {
  for (let y = fromYear; y < toYear; y++)
    for (let m = 0; m < 12; m++) {
      const t = Date.UTC(y, m, 15) / 1000;
      if (-new Date(t * 1000).getTimezoneOffset() * 60 !== zoneOffset(timeZone, t)) return false;
    }
  // the daylight saving changes too
  return zoneTransitions(timeZone, fromYear, toYear)
    .slice(1)
    .every(([t, o]) => -new Date(t * 1000).getTimezoneOffset() * 60 === o && -new Date((t - 3600) * 1000).getTimezoneOffset() * 60 !== o);
}
