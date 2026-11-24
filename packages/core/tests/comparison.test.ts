import { afterEach, describe, expect, it } from "vitest";
import { distributionOfUsers, MIN_USERS, positionOf, quantile, standingAmong, summarySentence, type PeriodStanding } from "../src/comparison/aggregate";
import { metricValue, periodValue, weeklyTotal, weeksCovering, type DayFacts } from "../src/comparison/daily-values";
import { addDays, startOfDay } from "../src/db/queries";
import { DEFAULT_VALID_DAY_HOURS, MIN_VALID_DAYS, getValidDayHours, isValidDay, setValidDayHours } from "../src/metrics";
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
    expect(distributionOfUsers([50, 10, null, 30, 40, 20, undefined])).toEqual({ median: 30, p25: 20, p75: 40, n: 5 });
    // even count, interpolated between the closest ranks (like numpy / R type 7)
    expect(distributionOfUsers([1, 2, 3, 4, 5, 6, 7, 8])).toEqual({ median: 4.5, p25: 2.75, p75: 6.25, n: 8 });
    expect(quantile([7], 0.25)).toBe(7);
    // the band always contains the median
    const d = distributionOfUsers([3, 99, 4, 4, 5, 1, 60, 8, 2]);
    expect(d.p25! <= d.median! && d.median! <= d.p75!).toBe(true);
  });

  it("hides median and percentiles when fewer than 5 users contributed", () => {
    expect(MIN_USERS).toBe(5);
    expect(distributionOfUsers([10, 20, 30, 40, null])).toEqual({ median: null, p25: null, p75: null, n: 4 });
    expect(distributionOfUsers([])).toEqual({ median: null, p25: null, p75: null, n: 0 });
    expect(distributionOfUsers([10, 20, 30, 40, 50]).median).toBe(30);
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
    expect(standingAmong([1, 2, 3, 4, null, null], 2)).toEqual({ median: null, p25: null, p75: null, n: 4, percentile: null });
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
  const st = (percentile: number | null, median: number | null = 8667): PeriodStanding => ({ median, p25: 6000, p75: 11000, n: 47, percentile });
  const line = (mine: number | null, myDays: number, standing: PeriodStanding) => summarySentence({ span: "Ultimi 30 giorni", mine, myDays, standing, text, fmt });

  it("judges between people with at least 7 valid days", () => {
    expect(MIN_VALID_DAYS).toBe(7);
    expect(line(4120, 12, st(35.4))).toBe("Ultimi 30 giorni: 4120 passi/giorno, nella norma. Più di 35 utenti su 100 (mediana degli altri 8667)");
    expect(line(2000, 12, st(8))).toBe("Ultimi 30 giorni: 2000 passi/giorno, sotto la norma. Più di 8 utenti su 100 (mediana degli altri 8667)");
    expect(line(16000, 7, st(96))).toBe("Ultimi 30 giorni: 16000 passi/giorno, sopra la norma. Più di 96 utenti su 100 (mediana degli altri 8667)");
    expect(line(1, 9, st(0))).toContain("sotto la norma. Meno di tutti gli altri utenti");
    expect(line(1, 9, st(1))).toContain("Più di 1 utente su 100");
  });

  it("asks for 7 valid days before judging, and never shows percentages", () => {
    expect(line(3500, 5, st(20))).toBe("Ultimi 30 giorni: 3500 passi/giorno. Servono almeno 7 giorni di dati per il confronto (ne hai 5)");
    expect(line(null, 0, st(null))).toBe("Ultimi 30 giorni: mediana degli altri 8667. Servono almeno 7 giorni di dati per il confronto (ne hai 0)");
    // a median of 0 (e.g. intensity minutes): no division, no percentage
    const zero = line(30, 10, { median: 0, p25: 0, p75: 20, n: 40, percentile: 70 });
    expect(zero).toBe("Ultimi 30 giorni: 30 passi/giorno, nella norma. Più di 70 utenti su 100 (mediana degli altri 0)");
    expect(zero).not.toMatch(/%|Infinity|NaN/);
  });

  it("without enough other users says so", () => {
    expect(line(5000, 20, { median: null, p25: null, p75: null, n: 3, percentile: null })).toBe("Ultimi 30 giorni: 5000 passi/giorno. Troppo pochi utenti per un confronto");
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
