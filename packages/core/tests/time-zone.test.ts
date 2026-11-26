/**
 * Days, hours and dates of the study's time zone (Europe/Rome), the same whatever the zone of the
 * device or of the process: this file also runs with TZ=America/New_York (vitest.other-tz.config.ts).
 */
import { describe, expect, it } from "vitest";
import { fmtDateTime, fmtDayLong, fmtDayMonth, fmtDayRange, fmtDayTitle, fmtMonth, fmtTime, fmtWeekTitle } from "../src/format";
import { STUDY_TIME_ZONE, addDays, dayKey, fromDayKey, localParts, monthStart, startOfDay, weekStart, zonedTime } from "../src/time-zone";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) / 1000;

describe(`the study's calendar (${STUDY_TIME_ZONE}), process TZ=${process.env.TZ}`, () => {
  it("starts days at Italian midnight", () => {
    // 24 Nov 2026, winter time (UTC+1): midnight is 23:00 UTC of the day before
    expect(startOfDay(utc(2026, 11, 24, 15))).toBe(utc(2026, 11, 23, 23));
    expect(startOfDay(utc(2026, 11, 23, 23))).toBe(utc(2026, 11, 23, 23));
    expect(startOfDay(utc(2026, 11, 23, 22, 59))).toBe(utc(2026, 11, 22, 23));
    // summer time (UTC+2)
    expect(startOfDay(utc(2026, 7, 1, 12))).toBe(utc(2026, 6, 30, 22));
    expect(dayKey(utc(2026, 11, 23, 23, 30))).toBe("2026-11-24");
    expect(fromDayKey("2026-11-24")).toBe(utc(2026, 11, 23, 23));
  });

  it("has days of 23 and 25 hours at the daylight saving changes", () => {
    const march = fromDayKey("2026-03-29");
    expect(addDays(march, 1) - march).toBe(23 * 3600);
    const october = fromDayKey("2026-10-25");
    expect(addDays(october, 1) - october).toBe(25 * 3600);
    expect(dayKey(addDays(october, 1))).toBe("2026-10-26");
    expect(dayKey(addDays(fromDayKey("2026-10-20"), 10))).toBe("2026-10-30");
  });

  it("weeks from Monday, months from the 1st, local hours", () => {
    expect(dayKey(weekStart(fromDayKey("2026-11-29")))).toBe("2026-11-23"); // Sunday -> Monday
    expect(dayKey(weekStart(fromDayKey("2026-11-23")))).toBe("2026-11-23");
    expect(dayKey(monthStart(fromDayKey("2026-11-24")))).toBe("2026-11-01");
    expect(dayKey(monthStart(fromDayKey("2026-11-24"), 2))).toBe("2027-01-01");
    expect(localParts(utc(2026, 11, 24, 6, 30))).toMatchObject({ hour: 7, minute: 30, weekday: 2 });
    expect(zonedTime(2026, 11, 24, 7, 30)).toBe(utc(2026, 11, 24, 6, 30));
  });

  it("shows dates and times in the study's zone", () => {
    const t = utc(2026, 11, 23, 23, 15); // 00:15 of 24 November in Italy
    expect(fmtTime(t)).toBe("00:15");
    expect(fmtDayMonth(t)).toBe("24 nov");
    expect(fmtDateTime(t)).toContain("24 nov 2026");
    // week intervals: the month once within a month, both across two
    expect(fmtDayRange(zonedTime(2026, 11, 16), zonedTime(2026, 11, 22))).toBe("16–22 nov");
    expect(fmtDayRange(zonedTime(2026, 10, 26), zonedTime(2026, 11, 1))).toBe("26 ott – 1 nov");
  });

  it("writes dates as Italian sentences: only the first letter capital, months lower case", () => {
    const t = utc(2026, 11, 25, 23, 30); // 00:30 of Thursday 26 November in Italy
    expect(fmtDayLong(t)).toBe("Giovedì 26 novembre 2026");
    expect(fmtDayTitle(t)).toBe("Giovedì 26 novembre");
    expect(fmtWeekTitle(zonedTime(2026, 11, 23), zonedTime(2026, 11, 29))).toBe("Lun 23 nov – dom 29 nov");
    expect(fmtMonth(zonedTime(2025, 12, 1))).toBe("Dicembre 2025");
  });
});
