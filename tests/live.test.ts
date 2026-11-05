import { describe, expect, it } from "vitest";
import { importFit } from "../src/lib/db/importer";
import { addDays, addDevice, dailyTotals, ensureDefaultUser, fitFileExists, insertFitFile, liveSamples, startOfDay } from "../src/lib/db/repo";
import { loadDay } from "../src/lib/day-data";
import { FakeWatch } from "../src/lib/demo/fake-watch";
import { generateDemoFiles } from "../src/lib/demo/generator";
import { GarminSession } from "../src/lib/garmin/session";
import { LiveRecorder } from "../src/lib/live-recorder";
import { memoryDb } from "./helpers";

const waitFor = async (cond: () => boolean, ms = 20_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("live data in the database", () => {
  it("stores one row per minute and adds only the steps taken while connected", async () => {
    const { db } = await memoryDb();
    const user = await ensureDefaultUser(db);
    const dev = await addDevice(db, { user_id: user.id, name: "vívosmart 5" });
    // synced data up to 14:00 of a day
    const now = new Date("2026-10-28T14:00:30");
    for (const f of generateDemoFiles({ days: 1, seed: 9, now })) await importFit(db, { deviceId: dev.id, userId: user.id }, f.data);
    const day = startOfDay(now.getTime() / 1000);
    const synced = (await dailyTotals(db, user.id, day, addDays(day, 1)))[0].steps;
    expect(synced).toBeGreaterThan(1000);

    // the band connects at 14:05; its day counter is 300 steps ahead of the synced data (those arrive with the next sync)
    let flushes = 0;
    const rec = new LiveRecorder(db, dev.id, user.id, () => flushes++);
    const t = day + 14 * 3600 + 5 * 60;
    await rec.push({ heartRate: 70, steps: synced + 300, bodyBattery: 55 }, t + 1);
    await rec.push({ heartRate: 72, steps: synced + 310 }, t + 20);
    await rec.push({ heartRate: 90, steps: synced + 400, respiration: 15 }, t + 61); // next minute
    await rec.push({ heartRate: 95, steps: synced + 520 }, t + 125); // and the next
    await rec.close();
    expect(flushes).toBe(3);

    const live = await liveSamples(db, user.id, day, addDays(day, 1));
    expect(live.map((l) => l.steps)).toEqual([10, 90, 120]);
    expect(live[0].heart_rate).toBe(71);
    expect(live[0].body_battery).toBe(55);
    expect(live[1].respiration).toBe(15);

    // charts: synced steps + steps measured live (never the whole counter again)
    const total = (await dailyTotals(db, user.id, day, addDays(day, 1)))[0].steps;
    expect(total).toBe(synced + 220);
    const d = await loadDay(db, user.id, day);
    expect(d.steps).toBe(synced + 220);
    expect(d.hr[d.hr.length - 1].value).toBe(95);
    expect(d.energy[d.energy.length - 1].value).toBe(55);

    // later the FIT files covering that period are synced: live rows of that period are ignored
    const later = new Date("2026-10-28T15:00:00");
    for (const f of generateDemoFiles({ days: 1, seed: 9, now: later })) await importFit(db, { deviceId: dev.id, userId: user.id }, f.data);
    expect((await liveSamples(db, user.id, day, addDays(day, 1))).length).toBe(0);
    const afterSync = (await dailyTotals(db, user.id, day, addDays(day, 1)))[0].steps;
    expect(afterSync).toBeGreaterThanOrEqual(synced);
    expect(afterSync).toBeLessThan(synced + 520 + 3000); // no double counting of the live minutes
  });

  it("a counter lower than the previous minute (midnight reset) counts from zero", async () => {
    const { db } = await memoryDb();
    const user = await ensureDefaultUser(db);
    const dev = await addDevice(db, { user_id: user.id, name: "x" });
    const rec = new LiveRecorder(db, dev.id, user.id, () => {});
    const midnight = startOfDay(Date.parse("2026-10-29T12:00:00") / 1000);
    await rec.push({ steps: 8990 }, midnight - 121);
    await rec.push({ steps: 9000 }, midnight - 61);
    await rec.push({ steps: 9010 }, midnight - 1);
    await rec.push({ steps: 12 }, midnight + 5);
    await rec.close();
    const rows = await liveSamples(db, user.id, midnight - 3600, midnight + 3600);
    expect(rows.map((r) => r.steps)).toEqual([10, 10, 12]);
  });
});

it("ignores impossible jumps of the counter (e.g. the band re-basing it)", async () => {
  const { db } = await memoryDb();
  const user = await ensureDefaultUser(db);
  const dev = await addDevice(db, { user_id: user.id, name: "x" });
  const rec = new LiveRecorder(db, dev.id, user.id, () => {});
  const t = startOfDay(Date.parse("2026-10-29T12:00:00") / 1000) + 12 * 3600;
  await rec.push({ steps: 5000 }, t);
  await rec.push({ steps: 9700 }, t + 61); // +4700 in a minute: not real steps
  await rec.push({ steps: 9750 }, t + 121);
  await rec.close();
  const rows = await liveSamples(db, user.id, t - 60, t + 3600);
  expect(rows.map((r) => r.steps)).toEqual([50]);
});

describe("demo band keeps recording", () => {
  it("every sync after some time finds a new monitoring file and the day continues", async () => {
    const { db } = await memoryDb();
    const user = await ensureDefaultUser(db);
    const dev = await addDevice(db, { user_id: user.id, name: "vívosmart 5" });
    let fakeNow = new Date("2026-10-28T10:00:00");
    const seed = 77;
    const watch = new FakeWatch({
      files: generateDemoFiles({ days: 2, seed, now: fakeNow }),
      newFiles: () => generateDemoFiles({ days: 1, seed, now: fakeNow }).filter((f) => f.subType === 32),
    });
    let done: { downloaded: number } | null = null;
    const session = new GarminSession(watch, {
      log: () => {},
      isAlreadyDownloaded: (e) => fitFileExists(db, dev.id, e),
      onFileDownloaded: async (e, data) => {
        await insertFitFile(db, dev.id, e, data);
        await importFit(db, { deviceId: dev.id, userId: user.id }, data);
      },
      onSyncFinished: (s) => {
        done = s;
      },
    }, { capabilityProfile: "gadgetbridge", keepOnDevice: false, fetchUnknownFiles: false, firstConnect: false, maxWriteSize: 20, syncTimeOnConnect: false, host: { name: "t", manufacturer: "t", model: "t" } });
    await session.start();
    await session.waitReady(5000);
    const day = startOfDay(fakeNow.getTime() / 1000);
    const stepsAt = async () => (await dailyTotals(db, user.id, day, addDays(day, 1)))[0].steps;

    await session.fetchRecordedData();
    await waitFor(() => done !== null);
    const first = await stepsAt();

    fakeNow = new Date("2026-10-28T13:00:00"); // three hours later
    done = null;
    await session.fetchRecordedData();
    await waitFor(() => done !== null);
    expect(done!.downloaded).toBeGreaterThan(0);
    const second = await stepsAt();
    expect(second).toBeGreaterThan(first);
    // same as importing the full day in one go
    const { db: ref } = await memoryDb();
    const u2 = await ensureDefaultUser(ref);
    const d2 = await addDevice(ref, { user_id: u2.id, name: "ref" });
    for (const f of generateDemoFiles({ days: 2, seed, now: fakeNow })) await importFit(ref, { deviceId: d2.id, userId: u2.id }, f.data);
    expect(second).toBe((await dailyTotals(ref, u2.id, day, addDays(day, 1)))[0].steps);
    await session.disconnect();
  });
});
