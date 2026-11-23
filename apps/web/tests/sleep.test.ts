import { describe, expect, it } from "vitest";
import { importFit } from "../src/lib/db/importer";
import { addDays, addDevice, ensureDefaultUser, sleepSessions, sleepTotal, startOfDay } from "../src/lib/db/repo";
import { BaseType as B } from "../src/lib/fit/decoder";
import { FitEncoder, toGarminTs } from "../src/lib/fit/encoder";
import { memoryDb } from "./helpers";

/** The structure of the real vívosmart 5 SLEEP file of the night 2→3 November 2026 (from a Gadgetbridge export). */
function realNight() {
  const t = (hm: string) => Date.parse(`2026-11-03T${hm}:00+01:00`) / 1000;
  const e = new FitEncoder();
  e.write(0, [{ num: 0, base: B.ENUM, value: 49 }, { num: 3, base: B.UINT32Z, value: 3480423114 }, { num: 4, base: B.UINT32, value: toGarminTs(t("09:43")) }]);
  e.write(273, [{ num: 253, base: B.UINT32, value: toGarminTs(t("09:43")) }, { num: 1, base: B.UINT16, value: 60 }]);
  for (const [hm, type] of [["02:05", 0], ["08:30", 1]] as const)
    e.write(21, [{ num: 253, base: B.UINT32, value: toGarminTs(t(hm)) }, { num: 0, base: B.ENUM, value: 74 }, { num: 1, base: B.ENUM, value: type }]);
  e.write(346, [{ num: 6, base: B.UINT8, value: 77 }, { num: 11, base: B.UINT8, value: 0 }]);
  const levels: [string, number][] = [
    ["02:29", 2], ["02:45", 3], ["03:36", 2], ["03:43", 3], ["05:13", 2], ["05:54", 4],
    ["06:47", 2], ["07:01", 4], ["07:08", 2], ["08:13", 4], ["08:30", 2],
  ];
  for (const [hm, lvl] of levels) e.write(275, [{ num: 253, base: B.UINT32, value: toGarminTs(t(hm)) }, { num: 0, base: B.ENUM, value: lvl }]);
  e.write(382, [{ num: 0, base: B.UINT32, value: 7500 }, { num: 1, base: B.UINT8, value: 57 }]);
  return { data: e.finish(), t };
}

describe("sleep as written by a real vívosmart 5", () => {
  it("one night from the sleep start/end events; each stage sample closes the stage (Gadgetbridge semantics)", async () => {
    const { db } = await memoryDb();
    const user = await ensureDefaultUser(db);
    const dev = await addDevice(db, { user_id: user.id, name: "vívosmart 5" });
    const { data, t } = realNight();
    await importFit(db, { deviceId: dev.id, userId: user.id }, data);
    const day = startOfDay(t("12:00"));
    const nights = await sleepSessions(db, user.id, day, addDays(day, 1));
    expect(nights.length).toBe(1);
    const n = nights[0];
    expect(n.start).toBe(t("02:05"));
    expect(n.end).toBe(t("08:30"));
    // same numbers Gadgetbridge shows for this night: deep 23 min, light 4 h 01, REM 2 h, total 6 h 25
    expect(n.minutes.deep).toBe(16 + 7);
    expect(n.minutes.light).toBe(24 + 51 + 90 + 53 + 7 + 17);
    expect(n.minutes.rem).toBe(41 + 14 + 65);
    expect(n.minutes.awake).toBe(0);
    expect(sleepTotal(n)).toBe(385);
    expect(n.score).toBe(77);
    expect(n.day).toBe(day);
    const restless = await db.all<{ timestamp: number }>("SELECT timestamp FROM sleep_restless_sample");
    expect(restless[0].timestamp).toBeGreaterThan(t("00:00")); // relative sleep_start is not used as a date
  });
});
