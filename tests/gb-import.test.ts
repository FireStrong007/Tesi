import { describe, expect, it } from "vitest";
import { importFit } from "../src/lib/db/importer";
import { addDays, addDevice, dailyTotals, ensureDefaultUser, listDevices, sleepSessions, sleepTotal, startOfDay, storeFitFile, tableCounts } from "../src/lib/db/repo";
import type { SqlExecutor } from "../src/lib/db/sql";
import { generateDemoFiles } from "../src/lib/demo/generator";
import type { FakeFile } from "../src/lib/demo/fake-watch";
import { DeviceManager } from "../src/lib/device-manager";
import { scanZip, type FitInput } from "../src/lib/gb-import";
import { listZip, readZipEntry, sourceFromBytes } from "../src/lib/zip";
import { memoryDb } from "./helpers";
import { writeZip } from "./zip-writer";

const TYPE_DIR: Record<number, string> = { 4: "ACTIVITY", 32: "MONITOR", 49: "SLEEP", 68: "HRV_STATUS" };
const MAC = "F0:1A:2B:3C:4D:5E";

/** A zip laid out like Gadgetbridge's "export zip". */
async function gadgetbridgeZip(files: FakeFile[]) {
  return writeZip([
    { name: "database/Gadgetbridge", data: new TextEncoder().encode("SQLite format 3\u0000 (finto)") },
    ...files.map((f) => {
      const t = TYPE_DIR[f.subType] ?? `FIT_TYPE_${f.subType}`;
      const iso = new Date(f.date * 1000).toISOString().replace(/[:.]/g, "-");
      return { name: `files/${MAC}/${t}/2026/${t}_${iso}.fit`, data: f.data };
    }),
    { name: `files/${MAC}/settings.json`, data: new TextEncoder().encode("{}"), store: true },
    { name: "gadgetbridge.json", data: new TextEncoder().encode('{"appVersionName":"0.88"}') },
  ]);
}

async function scanBytes(zip: Uint8Array): Promise<FitInput[]> {
  return (await scanZip(sourceFromBytes(zip))).fitFiles;
}

async function stepsOfDay(db: SqlExecutor, userId: number, day: number) {
  return (await dailyTotals(db, userId, day, addDays(day, 1)))[0].steps;
}

/** reference: the same files imported directly, in date order */
async function reference(files: FakeFile[], day: number) {
  const { db } = await memoryDb();
  const u = await ensureDefaultUser(db);
  const d = await addDevice(db, { user_id: u.id, name: "ref" });
  for (const f of [...files].sort((a, b) => a.date - b.date)) await importFit(db, { deviceId: d.id, userId: u.id }, f.data);
  return stepsOfDay(db, u.id, day);
}

describe("zip reader", () => {
  it("reads deflated entries with data descriptors (Java ZipOutputStream) and stored entries", async () => {
    const big = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7) & 0xff);
    const zip = await writeZip([
      { name: "a.txt", data: new TextEncoder().encode("ciao") },
      { name: "dir/b.bin", data: big },
      { name: "c.raw", data: Uint8Array.of(1, 2, 3), store: true },
    ]);
    const src = sourceFromBytes(zip);
    const entries = await listZip(src);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "dir/b.bin", "c.raw"]);
    expect(new TextDecoder().decode(await readZipEntry(src, entries[0]))).toBe("ciao");
    const b = await readZipEntry(src, entries[1]);
    expect(b.length).toBe(200_000);
    expect(b[123_457]).toBe((123_457 * 7) & 0xff);
    expect(Array.from(await readZipEntry(src, entries[2]))).toEqual([1, 2, 3]);
  });

  it("rejects something that is not a zip", async () => {
    let failed = false;
    try {
      await listZip(sourceFromBytes(new TextEncoder().encode("non sono uno zip")));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

describe("import from Gadgetbridge", () => {
  const now = new Date("2026-10-28T22:00:00");
  const day = startOfDay(now.getTime() / 1000);

  it("recognises a Gadgetbridge export and imports it like a direct sync", async () => {
    const files = generateDemoFiles({ days: 3, seed: 21, now });
    const zip = await gadgetbridgeZip(files);
    const scan = await scanZip(sourceFromBytes(zip));
    expect(scan.hasGadgetbridgeDatabase).toBe(true);
    expect(scan.bands).toEqual([MAC]);
    expect(scan.fitFiles.length).toBe(files.length); // settings.json and the database are ignored

    const { db } = await memoryDb();
    const user = await ensureDefaultUser(db);
    const manager = new DeviceManager(db, () => user.id);
    const report = await manager.importExternal(scan.fitFiles, { userId: user.id, fallbackDevice: "new" });
    expect(report.added).toBe(files.length);
    expect(report.invalid.length).toBe(0);
    expect(report.createdDevice?.name).toBe("vívosmart 5");
    const devices = await listDevices(db, user.id);
    expect(devices.length).toBe(1);
    expect(devices[0].unit_number).toBe("3412345678"); // serial number from the FIT files

    expect(await stepsOfDay(db, user.id, day)).toBe(await reference(files, day));
    const counts = await tableCounts(db);
    expect(counts.sleep_stage_sample).toBeGreaterThan(20); // only stage changes, like a real band
    expect(counts.workout).toBeGreaterThanOrEqual(0);
    const nights = await sleepSessions(db, user.id, addDays(day, -2), addDays(day, 1));
    expect(nights.length).toBe(3);
    for (const n of nights) expect(sleepTotal(n)).toBeGreaterThan(300);

    // importing the same zip again changes nothing
    const again = await manager.importExternal(await scanBytes(zip), { userId: user.id, fallbackDevice: "new" });
    expect(again.added).toBe(0);
    expect(again.duplicates).toBe(files.length);
    expect((await listDevices(db, user.id)).length).toBe(1); // matched by serial, no new device
    expect(await stepsOfDay(db, user.id, day)).toBe(await reference(files, day));
  });

  it("attaches files to the band already in the app (same serial number)", async () => {
    const { db } = await memoryDb();
    const user = await ensureDefaultUser(db);
    const band = await addDevice(db, { user_id: user.id, name: "Il mio vívosmart" });
    await db.run("UPDATE device SET unit_number = '3412345678' WHERE id = ?", [band.id]);
    const other = await addDevice(db, { user_id: user.id, name: "Altro" });
    const manager = new DeviceManager(db, () => user.id);
    const report = await manager.importExternal(await scanBytes(await gadgetbridgeZip(generateDemoFiles({ days: 1, seed: 3, now }))), {
      userId: user.id,
      fallbackDevice: other.id,
    });
    expect(report.matchedBySerial).toBe(report.found);
    expect([...report.touched.keys()]).toEqual([band.id]);
  });

  it("older Gadgetbridge files imported after newer band data: the day is rebuilt correctly", async () => {
    const all = generateDemoFiles({ days: 2, seed: 33, now });
    const yesterday = addDays(day, -1);
    const older = all.filter((f) => f.date < day + 3600); // Gadgetbridge had yesterday's files
    const newer = all.filter((f) => f.date >= day + 3600); // today's came straight from the band
    const { db } = await memoryDb();
    const user = await ensureDefaultUser(db);
    const manager = new DeviceManager(db, () => user.id);
    const first = await manager.importExternal(await scanBytes(await gadgetbridgeZip(newer)), { userId: user.id, fallbackDevice: "new" });
    expect(first.added).toBe(newer.length);
    const second = await manager.importExternal(await scanBytes(await gadgetbridgeZip(older)), { userId: user.id, fallbackDevice: "new" });
    expect(second.added).toBe(older.length);
    expect(await stepsOfDay(db, user.id, yesterday)).toBe(await reference(all, yesterday));
    expect(await stepsOfDay(db, user.id, day)).toBe(await reference(all, day));
  });

  it("a file downloaded from the band after importing it from Gadgetbridge is not counted twice", async () => {
    const files = generateDemoFiles({ days: 1, seed: 8, now });
    const { db } = await memoryDb();
    const user = await ensureDefaultUser(db);
    const manager = new DeviceManager(db, () => user.id);
    const report = await manager.importExternal(await scanBytes(await gadgetbridgeZip(files)), { userId: user.id, fallbackDevice: "new" });
    const deviceId = [...report.touched.keys()][0];
    const before = await stepsOfDay(db, user.id, day);
    const monitor = files.find((f) => f.subType === 32)!;
    const res = await storeFitFile(db, deviceId, {
      fileIndex: 7, fileDataType: 128, fileSubType: 32, fileNumber: 99, specificFlags: 0, fileFlags: 0, fileSize: monitor.data.length, fileDate: monitor.date,
    }, monitor.data);
    expect(res.duplicate).toBe(true);
    await manager.processPendingFiles(deviceId);
    expect(await stepsOfDay(db, user.id, day)).toBe(before);
  });
});
