import { afterEach, describe, expect, it } from "vitest";
import { distributionOfUsers, METRIC_WORDS, MIN_USERS, noOthersMessage, positionOf, quantile, rankSentence, standingAmong, summarySentence, type ComparableStanding } from "../src/comparison/aggregate";
import { COMPARE_METRICS, type CompareMetric } from "../src/comparison/types";
import { metricValue, periodValue, weeklyTotal, weeksCovering, type DayFacts } from "../src/comparison/daily-values";
import { addDays, startOfDay } from "../src/db/queries";
import { DEFAULT_VALID_DAY_HOURS, MIN_VALID_DAYS, getValidDayHours, isValidDay, setValidDayHours } from "../src/metrics";
import { FactsComparisonSource, type PersonFacts } from "../src/comparison/facts";
import { loadRange } from "../src/range-data";
import { createLocalViews } from "../src/server/views";
import { localParts } from "../src/time-zone";
import { addParticipant, serverDb } from "./helpers";

const NOW = new Date("2026-10-28T20:00:00");
const nowTs = Math.floor(NOW.getTime() / 1000);
const today = startOfDay(nowTs);

describe("daily distribution of the other users", () => {
  it("computes median and 25th/75th percentile of the users with valid data", () => {
    // sorted: 10 20 30 40 50 -> positions 1, 2, 3
    expect(distributionOfUsers([50, 10, null, 30, 40, 20, undefined])).toEqual({ median: 30, p25: 20, p75: 40, mean: 30, n: 5 });
    // even count, interpolated between the closest ranks (like numpy / R type 7)
    expect(distributionOfUsers([1, 2, 3, 4, 5, 6, 7, 8])).toEqual({ median: 4.5, p25: 2.75, p75: 6.25, mean: 4.5, n: 8 });
    expect(quantile([7], 0.25)).toBe(7);
    // the band always contains the median
    const d = distributionOfUsers([3, 99, 4, 4, 5, 1, 60, 8, 2]);
    expect(d.p25! <= d.median! && d.median! <= d.p75!).toBe(true);
  });

  it("hides median, percentiles and mean when fewer than 5 users contributed (or the configured minimum)", () => {
    expect(MIN_USERS).toBe(5);
    expect(distributionOfUsers([10, 20, 30, 40, null])).toEqual({ median: null, p25: null, p75: null, mean: null, n: 4 });
    expect(distributionOfUsers([])).toEqual({ median: null, p25: null, p75: null, mean: null, n: 0 });
    expect(distributionOfUsers([10, 20, 30, 40, 50]).median).toBe(30);
    // the mean is not the median: one far value moves it
    expect(distributionOfUsers([1, 2, 3, 4, 100])).toMatchObject({ median: 3, mean: 22 });
    expect(distributionOfUsers([10, 20, 30, 40, 50], 6).median).toBeNull();
  });
});

describe("standing among the other users (between people)", () => {
  it("ranks the user's period value among the others' period values", () => {
    const others = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
    const st = standingAmong(others, 4500);
    expect(st.n).toBe(10);
    expect(st.median).toBe(5500);
    expect(st.percentile).toBe(40); // 4 of 10 below
    expect(standingAmong(others, 4000).percentile).toBe(35); // ties count half
    expect(standingAmong(others, 500).percentile).toBe(0);
    expect(standingAmong(others, 20000).percentile).toBe(100);
    expect(standingAmong(others, null).percentile).toBeNull();
  });

  it("needs at least 5 other users for percentiles and rank", () => {
    expect(standingAmong([1, 2, 3, 4, null, null], 2)).toEqual({ median: null, p25: null, p75: null, mean: null, n: 4, percentile: null });
    expect(standingAmong([1, 2, 3, 4, 5], 2).percentile).toBe(30);
  });

  it("says below / within / above the norm from the percentile rank", () => {
    expect(positionOf(10)).toBe("below");
    expect(positionOf(24.9)).toBe("below");
    expect(positionOf(25)).toBe("within");
    expect(positionOf(75)).toBe("within");
    expect(positionOf(75.1)).toBe("above");
  });
});

describe("summary line", () => {
  const fmt = (v: number) => String(Math.round(v));
  const text = (v: number) => `${fmt(v)} passi/giorno`;
  const st = (percentile: number | null, mine: number | null, myDays: number, over: Partial<ComparableStanding> = {}): ComparableStanding => ({
    median: 8667, p25: 6000, p75: 11000, mean: 8667, n: 47, percentile,
    mine: { value: mine, days: myDays }, comparable: { count: 24, unit: "day" }, noOthers: false, ...over,
  });
  const line = (s: ComparableStanding, metric: CompareMetric = "steps") => summarySentence({ metric, span: "Novembre", standing: s, text, fmt });

  it("judges between people over the comparable days, and says how many they are", () => {
    expect(MIN_VALID_DAYS).toBe(7);
    expect(line(st(35.4, 4120, 12))).toBe("Novembre, su 24 giorni confrontabili: 4120 passi/giorno, nella norma. Fai più passi di circa 35 partecipanti su 100 (mediana degli altri 8667)");
    expect(line(st(8, 2000, 12))).toBe("Novembre, su 24 giorni confrontabili: 2000 passi/giorno, sotto la norma. Fai più passi di circa 8 partecipanti su 100 (mediana degli altri 8667)");
    expect(line(st(96, 16000, 7))).toContain("sopra la norma. Fai più passi di circa 96 partecipanti su 100");
    expect(line(st(0, 1, 9))).toContain("sotto la norma. Fai meno passi di tutti gli altri partecipanti");
    expect(line(st(100, 1, 9))).toContain("Fai più passi di tutti gli altri partecipanti");
    expect(line(st(1, 1, 9))).toContain("Fai più passi di circa 1 partecipante su 100");
    expect(line(st(50, 9, 9, { comparable: { count: 1, unit: "day" } }))).toMatch(/^Novembre, su 1 giorno confrontabile: /);
    expect(line(st(40, 250, 21, { comparable: { count: 3, unit: "week" } }), "intensity")).toBe(
      "Novembre, su 3 settimane confrontabili: 250 passi/giorno, nella norma. Hai più minuti di intensità di circa 40 partecipanti su 100 (mediana degli altri 8667)",
    );
    expect(line(st(40, 250, 7, { comparable: { count: 1, unit: "week" } }), "intensity")).toMatch(/^Novembre, su 1 settimana confrontabile: /);
  });

  it("each metric with its own verb", () => {
    const rank = (m: CompareMetric) => line(st(40, 5, 10), m).split(". ")[1];
    expect(rank("sleep")).toMatch(/^Dormi più a lungo di circa 40 partecipanti su 100/);
    expect(rank("calories")).toMatch(/^Bruci più calorie attive di circa 40/);
    expect(rank("resting_hr")).toMatch(/^Hai il battito a riposo più alto di circa 40/);
    expect(rank("stress")).toMatch(/^Hai uno stress medio più alto di circa 40/);
    expect(rank("body_battery")).toMatch(/^Hai una Body Battery massima più alta di circa 40/);
    for (const m of COMPARE_METRICS) {
      expect(rankSentence(m, 40)).toMatch(/ di circa 40 partecipanti su 100$/);
      expect(rankSentence(m, 0)).toMatch(/ di tutti gli altri partecipanti$/);
      expect(METRIC_WORDS[m].about).toMatch(/^su(i|l|lla|lle|llo) /);
    }
  });

  it("asks for 7 valid days among the comparable ones before judging, and never shows percentages", () => {
    expect(line(st(20, 3500, 5))).toBe("Novembre, su 24 giorni confrontabili: 3500 passi/giorno. Servono almeno 7 giorni con i tuoi dati tra quelli confrontabili (ne hai 5)");
    expect(line(st(null, null, 0))).toBe("Novembre, su 24 giorni confrontabili: nessun tuo dato. Servono almeno 7 giorni con i tuoi dati tra quelli confrontabili (ne hai 0)");
    // a median of 0 (e.g. intensity minutes): no division, no percentage
    const zero = line(st(70, 30, 10, { median: 0, p25: 0, p75: 20 }));
    expect(zero).toContain("nella norma. Fai più passi di circa 70 partecipanti su 100 (mediana degli altri 0)");
    expect(zero).not.toMatch(/%|Infinity|NaN/);
  });

  it("without enough other participants, or without any, says so", () => {
    expect(line(st(null, 5000, 20, { median: null, n: 3 }))).toBe("Novembre, su 24 giorni confrontabili: 5000 passi/giorno. Non ci sono abbastanza partecipanti per un confronto");
    expect(line(st(null, 5000, 20, { median: null, n: 0, comparable: { count: 0, unit: "day" } }))).toBe("Novembre: Non ci sono abbastanza partecipanti per un confronto in nessun giorno del periodo");
    expect(line(st(null, 5000, 20, { median: null, n: 0, comparable: { count: 0, unit: "week" } }))).toContain("in nessuna settimana del periodo");
    expect(line(st(null, 400, 20, { median: null, n: 0, comparable: { count: 0, unit: "day" }, noOthers: true }), "sleep")).toBe("Nessun altro partecipante ha dati sul sonno in questo periodo");
    expect(noOthersMessage("spo2", "giorno")).toBe("Nessun altro partecipante ha dati sulla SpO₂ in questo giorno");
    expect(noOthersMessage("intensity", "settimana")).toBe("Nessun altro partecipante ha dati sui minuti di intensità in questa settimana");
  });
});

describe("valid days and period values", () => {
  const facts = (hrHours: number, steps = 5000): DayFacts => ({
    hrHours, steps, activeCalories: 300, moderateMinutes: 10, vigorousMinutes: 5, sleep: null, restingHr: 60,
    stressAvg: 30, bodyBatteryMax: 80, spo2Avg: null, respirationAvg: 15, hrvNightAvg: null,
  });

  afterEach(() => setValidDayHours(DEFAULT_VALID_DAY_HOURS));

  it("a day with the band worn less than 12 hours is no data, not 0", () => {
    expect(getValidDayHours()).toBe(12);
    expect(isValidDay(11)).toBe(false);
    expect(isValidDay(12)).toBe(true);
    expect(metricValue("steps", facts(0, 0))).toBeNull();
    expect(metricValue("steps", facts(4, 300))).toBeNull();
    expect(metricValue("calories", facts(11))).toBeNull();
    expect(metricValue("intensity", facts(11))).toBeNull();
    expect(metricValue("steps", facts(14, 0))).toBe(0); // worn all day without walking: a real 0
    expect(metricValue("intensity", facts(14))).toBe(20);
  });

  it("the threshold is configurable, one value for everyone", () => {
    setValidDayHours(10);
    expect(isValidDay(10)).toBe(true);
    expect(metricValue("steps", facts(10, 5000))).toBe(5000);
    expect(() => setValidDayHours(0)).toThrow();
    expect(() => setValidDayHours(25)).toThrow();
  });

  it("today does not count in the period value until it is over (the user and the others alike)", () => {
    const days = [addDays(today, -2), addDays(today, -1), today];
    // today's partial 500 steps would pull the mean down
    expect(periodValue("steps", days, [8000, 6000, 500], nowTs)).toEqual({ value: 7000, days: 2 });
    expect(periodValue("steps", days, [8000, 6000, 500], addDays(today, 1) + 60)).toEqual({ value: 4833.333333333333, days: 3 });
  });

  it("FactsComparisonSource: the asking person's own value from their facts, never among the others", async () => {
    const days = Array.from({ length: 10 }, (_, i) => addDays(today, i - 10));
    const person = (key: string, steps: number): PersonFacts => ({ key, id: 0, days, facts: days.map(() => facts(14, steps)) });
    const src = new FactsComparisonSource([person("me", 3000), ...[4000, 5000, 6000, 7000, 8000].map((v, i) => person(`p${i}`, v))], () => nowTs);
    const st = await src.standingOf("steps", days[0], today, "me");
    expect(st.mine).toEqual({ value: 3000, days: 10 });
    expect(st.comparable).toEqual({ count: 10, unit: "day" });
    expect(st.noOthers).toBe(false);
    expect(st.n).toBe(5);
    expect(st.median).toBe(6000);
    expect(st.mean).toBe(6000);
    expect(st.percentile).toBe(0);
    const d = await src.dailyDistribution("steps", days[0], today, { excludeUserId: "me" });
    expect(d.every((x) => x.n === 5 && x.median === 6000)).toBe(true);
    // one fewer than the minimum: nothing
    const four = await src.dailyDistribution("steps", days[0], today, { excludeUserId: "p0" });
    expect(four[0].n).toBe(5); // "me" is now among the others
    const strict = new FactsComparisonSource(src.people, () => nowTs, 6);
    expect((await strict.dailyDistribution("steps", days[0], today, { excludeUserId: "me" }))[0]).toMatchObject({ n: 5, median: null, mean: null });
  });

  it("the standing uses only the comparable days (and weeks): the same days for the participant and the others", async () => {
    // 20 days; on the last 10 only 4 others have data: below the minimum, nothing to compare with
    const days = Array.from({ length: 20 }, (_, i) => addDays(today, i - 20));
    const person = (key: string, steps: (i: number) => number | null): PersonFacts => ({
      key, id: 0, days, facts: days.map((_, i) => (steps(i) == null ? facts(0, 0) : facts(14, steps(i)!))),
    });
    const others = [4000, 5000, 6000, 7000].map((v, k) => person(`p${k}`, () => v));
    const src = new FactsComparisonSource([person("me", (i) => (i < 10 ? 3000 : 9000)), ...others, person("p4", (i) => (i < 10 ? 8000 : null))], () => nowTs);
    const daily = await src.dailyDistribution("steps", days[0], today, { excludeUserId: "me" });
    expect(daily.map((d) => d.median != null)).toEqual(days.map((_, i) => i < 10));
    const st = await src.standingOf("steps", days[0], today, "me");
    // the participant's 9000 steps of the last 10 days are not counted: the others have no value there
    expect(st.comparable).toEqual({ count: 10, unit: "day" });
    expect(st.mine).toEqual({ value: 3000, days: 10 });
    expect(st).toMatchObject({ n: 5, median: 6000, percentile: 0 });
    expect(summarySentence({ metric: "steps", span: "Novembre", standing: st, text: String, fmt: String })).toMatch(/^Novembre, su 10 giorni confrontabili: 3000, sotto la norma\. Fai meno passi di tutti/);
    // today is never comparable, even with everyone's data
    const withToday = await src.standingOf("steps", days[0], addDays(today, 1), "me");
    expect(withToday.comparable.count).toBe(10);
    // a metric that no one else has
    const spo2 = await src.standingOf("spo2", days[0], today, "me");
    expect(spo2).toMatchObject({ noOthers: true, comparable: { count: 0 }, median: null });
    // weekly metrics: complete weeks on which the weekly distribution exists
    const weeks = weeksCovering(days[0], today).filter((w) => w.end <= today);
    const wk = await src.standingOf("intensity", weeks[0].start, weeks[weeks.length - 1].end, "me");
    expect(wk.comparable.unit).toBe("week");
    const weekly = await src.weeklyDistribution("intensity", weeks[0].start, weeks[weeks.length - 1].end, { excludeUserId: "me" });
    expect(wk.comparable.count).toBe(weekly.filter((w) => w.median != null && addDays(w.day, 7) <= today).length);
  });

  it("a period value is the mean of the valid days", () => {
    const days = Array.from({ length: 5 }, (_, i) => addDays(today, i - 10));
    expect(periodValue("steps", days, [1000, null, 3000, null, 5000], nowTs)).toEqual({ value: 3000, days: 3 });
    expect(periodValue("steps", days, [null, null, null, null, null], nowTs)).toEqual({ value: null, days: 0 });
  });

  it("weekly totals: Monday to Sunday, valid days only, mean over complete weeks", () => {
    const monday = weeksCovering(addDays(today, -20), today)[0].start;
    expect(localParts(monday).weekday).toBe(1);
    const days = Array.from({ length: 21 }, (_, i) => addDays(monday, i));
    const values = days.map((_, i) => (i < 7 ? 10 : i < 14 ? (i % 2 ? 30 : null) : 5));
    const [w1, w2] = weeksCovering(days[0], addDays(days[20], 1));
    expect(weeklyTotal(days, values, w1, nowTs)).toBe(70);
    expect(weeklyTotal(days, values, w2, nowTs)).toBe(120); // 4 valid days of 7
    // fewer than half of the days valid: no total
    expect(weeklyTotal(days, days.map((_, i) => (i < 3 ? 50 : null)), w1, nowTs)).toBeNull();
    const pv = periodValue("intensity", days, values, nowTs);
    expect(pv.days).toBe(18);
    // weeks entirely before today count; the week containing today does not
    const complete = weeksCovering(days[0], addDays(days[20], 1)).filter((w) => w.end <= today);
    expect(pv.value).toBeCloseTo([70, 120, 35].slice(0, complete.length).reduce((a, b) => a + b, 0) / complete.length, 6);
  });
});

describe("loadRange stress average", () => {
  it("ignores samples that are not measurements (< 1)", async () => {
    const db = serverDb();
    const { pid, did } = await addParticipant(db, "p");
    for (const [t, v] of [[today + 3600, 0], [today + 7200, 40], [today + 10800, 60]])
      await db.run("INSERT INTO GARMIN_STRESS_SAMPLE (TIMESTAMP, DEVICE_ID, USER_ID, STRESS) VALUES (?, ?, ?, ?)", [t * 1000, did, pid, v]);
    await createLocalViews(db);
    const r = await loadRange(db, pid, today, addDays(today, 1));
    expect(r.stress[0].avg).toBe(50);
    expect(r.stress[0].min).toBe(40);
  });
});
