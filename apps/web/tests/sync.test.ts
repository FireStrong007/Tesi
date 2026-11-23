import { describe, expect, it } from "vitest";
import { importFit } from "../src/lib/db/importer";
import { addDevice, ensureDefaultUser, fitFileExists, insertFitFile, tableCounts } from "../src/lib/db/repo";
import { FakeWatch } from "../src/lib/demo/fake-watch";
import { generateDemoFiles } from "../src/lib/demo/generator";
import { Msg } from "../src/lib/garmin/gfdi";
import { GarminSession, type SessionOptions } from "../src/lib/garmin/session";
import { memoryDb } from "./helpers";

const opts: SessionOptions = {
  capabilityProfile: "gadgetbridge",
  keepOnDevice: false,
  fetchUnknownFiles: false,
  firstConnect: true,
  maxWriteSize: 20,
  syncTimeOnConnect: true,
  host: { name: "Test", manufacturer: "Test", model: "node" },
};

const waitFor = async (cond: () => boolean, ms = 20_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("GarminSession against the simulated vívosmart 5", () => {
  it("pairs, syncs all files into SQLite and archives them on the band", async () => {
    const { db } = await memoryDb();
    const user = await ensureDefaultUser(db);
    const dev = await addDevice(db, { user_id: user.id, name: "vívosmart 5" });
    const files = generateDemoFiles({ days: 3, seed: 3, now: new Date("2026-10-28T20:00:00") });
    const watch = new FakeWatch({ files, mtu: 100 });
    const logs: string[] = [];
    let battery = -1;
    let finished: { downloaded: number; skipped: number; failed: number } | null = null;

    const session = new GarminSession(watch, {
      log: (l, m) => logs.push(`${l} ${m}`),
      onBattery: (b) => (battery = b),
      isAlreadyDownloaded: (e) => fitFileExists(db, dev.id, e),
      onFileDownloaded: async (e, data) => {
        const id = await insertFitFile(db, dev.id, e, data);
        await importFit(db, { deviceId: dev.id, userId: user.id, fitFileId: id }, data);
      },
      onSyncFinished: (s) => {
        finished = s;
      },
    }, { ...opts });

    await session.start();
    expect(await session.waitReady(5000)).toBe(true);
    expect(session.deviceInfo?.deviceName).toBe("vívosmart 5");
    await waitFor(() => battery > 0);
    expect(battery).toBe(78);

    // the host must have answered with its configuration and the time
    const sentTypes = watch.received.map((r) => r.type);
    expect(sentTypes).toContain(Msg.CONFIGURATION);
    expect(sentTypes).toContain(Msg.SUPPORTED_FILE_TYPES_REQUEST);
    expect(sentTypes).toContain(Msg.SYSTEM_EVENT);

    await session.fetchRecordedData();
    await waitFor(() => finished !== null);
    expect(finished!.downloaded).toBe(files.length);
    expect(finished!.failed).toBe(0);
    expect(watch.archivedCount).toBe(files.length);
    await waitFor(() => session.state === "ready");

    const counts = await tableCounts(db);
    expect(counts.fit_file).toBe(files.length);
    expect(counts.activity_sample).toBeGreaterThan(1000);
    expect(counts.sleep_stage_sample).toBeGreaterThan(20); // only stage changes, like a real band
    expect(counts.stress_sample).toBeGreaterThan(100);
    expect(counts.hrv_summary_sample).toBeGreaterThan(0);
    expect(logs.some((l) => l.startsWith("error"))).toBe(false);

    // a second sync finds nothing new (files archived)
    finished = null;
    await session.fetchRecordedData();
    await waitFor(() => finished !== null);
    expect(finished!.downloaded).toBe(0);
    await session.disconnect();
    expect(session.state).toBe("disconnected");
  });

  it("follows a band-initiated sync (Synchronization -> Filter -> directory)", async () => {
    const { db } = await memoryDb();
    const user = await ensureDefaultUser(db);
    const dev = await addDevice(db, { user_id: user.id, name: "vívosmart 5" });
    const files = generateDemoFiles({ days: 1, seed: 5, now: new Date("2026-10-28T12:00:00") });
    const watch = new FakeWatch({ files });
    let done = false;
    const session = new GarminSession(watch, {
      log: () => {},
      isAlreadyDownloaded: (e) => fitFileExists(db, dev.id, e),
      onFileDownloaded: async (e, data) => {
        await insertFitFile(db, dev.id, e, data);
      },
      onSyncFinished: () => {
        done = true;
      },
    }, { ...opts, firstConnect: false });
    await session.start();
    await session.waitReady(5000);
    watch.requestSync();
    await waitFor(() => done);
    expect((await tableCounts(db)).fit_file).toBe(files.length);
    await session.disconnect();
  });
});

describe("live channels", () => {
  it("opens the realtime channels and decodes heart rate, steps, Body Battery and respiration", async () => {
    const watch = new FakeWatch({ files: [] });
    watch.liveIntervals = { 6: 20, 7: 20, 9: 20, 19: 20, 20: 20, 21: 20 };
    const got: Record<string, number> = {};
    const session = new GarminSession(watch, {
      log: () => {},
      onRealtime: (u) => Object.assign(got, u),
    }, { ...opts, firstConnect: false });
    await session.start();
    await session.waitReady(5000);
    await session.setRealtime(true);
    await session.setRealtime(true); // idempotent: must not register twice
    await waitFor(() => got.heartRate !== undefined && got.steps !== undefined && got.bodyBattery !== undefined && got.respiration !== undefined && got.floorsUp !== undefined, 5000);
    expect(got.heartRate).toBeGreaterThan(40);
    expect(got.steps).toBeGreaterThan(1000);
    expect(got.stepGoal).toBe(8000);
    expect(got.spo2).toBe(undefined); // SpO2 is opt-in
    const registrations = watch.registrations.filter((s) => s === 6).length;
    expect(registrations).toBe(1);
    await session.setRealtime(true, true);
    await waitFor(() => got.spo2 !== undefined, 5000);
    await session.setRealtime(false);
    await new Promise((r) => setTimeout(r, 100));
    const before = { ...got };
    got.heartRate = -1;
    await new Promise((r) => setTimeout(r, 150));
    expect(got.heartRate).toBe(-1); // nothing arrives after closing
    expect(before.spo2).toBeGreaterThan(90);
    await session.disconnect();
  });
});
