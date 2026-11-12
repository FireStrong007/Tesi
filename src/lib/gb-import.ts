/**
 * Import from Gadgetbridge.
 *
 * Gadgetbridge keeps every FIT file it downloads from a Garmin band in its external files
 * folder, and its "export zip" (data management) contains that folder:
 *
 *   database/Gadgetbridge                      (its own SQLite database - not needed here)
 *   files/<band MAC>/MONITOR/2026/MONITOR_2026-11-02T10-15-00.fit
 *   files/<band MAC>/SLEEP/2026/SLEEP_….fit, …/ACTIVITY/…, …/HRV_STATUS/…
 *   gadgetbridge.json
 *
 * Those files are byte-for-byte what the band sent, so importing them gives the same data as
 * syncing the band directly. Files already present (same content) are skipped.
 */
import { decodeFit, num } from "./fit/decoder";
import type { DirectoryEntry } from "./garmin/gfdi";
import { addDevice, getUser, listDevices, storeFitFile, type Device } from "./db/repo";
import type { SqlExecutor } from "./db/sql";
import { listZip, readZipEntry, sourceFromBlob, type ZipEntry, type ZipSource } from "./zip";

export interface FitInput {
  /** path inside the zip, or file name */
  name: string;
  read(): Promise<Uint8Array>;
  /** fallback date (unix seconds) when the FIT file has no creation time */
  mtime: number;
}

export interface GbScan {
  kind: "gadgetbridge-zip" | "zip" | "files";
  fitFiles: FitInput[];
  /** band folders (MAC addresses) found in a Gadgetbridge export */
  bands: string[];
  hasGadgetbridgeDatabase: boolean;
}

const isFit = (name: string) => /\.fit$/i.test(name);

/** Looks into the picked files: a Gadgetbridge export zip, any zip with .fit files, or loose .fit files. */
export async function scanImport(picked: File[]): Promise<GbScan> {
  const fitFiles: FitInput[] = [];
  const bands = new Set<string>();
  let hasDb = false;
  let zips = 0;
  for (const f of picked) {
    if (/\.zip$/i.test(f.name) || f.type === "application/zip") {
      zips++;
      const src = sourceFromBlob(f);
      const scan = await scanZip(src);
      fitFiles.push(...scan.fitFiles);
      scan.bands.forEach((b) => bands.add(b));
      hasDb ||= scan.hasGadgetbridgeDatabase;
    } else if (isFit(f.name)) {
      fitFiles.push({ name: f.name, mtime: Math.floor(f.lastModified / 1000), read: async () => new Uint8Array(await f.arrayBuffer()) });
    }
  }
  return { kind: hasDb || bands.size ? "gadgetbridge-zip" : zips ? "zip" : "files", fitFiles, bands: [...bands], hasGadgetbridgeDatabase: hasDb };
}

export async function scanZip(src: ZipSource): Promise<GbScan> {
  const entries = await listZip(src);
  const bands = new Set<string>();
  const fitFiles: FitInput[] = [];
  for (const e of entries) {
    if (e.isDirectory || !isFit(e.name)) continue;
    const m = e.name.match(/(?:^|\/)files\/([^/]+)\//);
    if (m) bands.add(m[1]);
    fitFiles.push(fitFromZip(src, e));
  }
  return {
    kind: "zip",
    fitFiles,
    bands: [...bands],
    hasGadgetbridgeDatabase: entries.some((e) => /(^|\/)database\/Gadgetbridge$/.test(e.name)),
  };
}

const fitFromZip = (src: ZipSource, e: ZipEntry): FitInput => ({ name: e.name, mtime: e.mtime, read: () => readZipEntry(src, e) });

export interface ImportTarget {
  userId: number;
  /** device to attach files to when the band cannot be recognised by serial number; "new" creates one */
  fallbackDevice: number | "new";
  newDeviceName?: string;
}

export interface ImportReport {
  found: number;
  added: number;
  duplicates: number;
  invalid: { name: string; error: string }[];
  /** device id -> earliest date (unix) among the files added to it */
  touched: Map<number, number>;
  createdDevice: Device | null;
  /** files whose band serial matched an existing device */
  matchedBySerial: number;
}

/**
 * Stores the FIT files in the database (not yet imported into the chart tables: the caller runs
 * the chronological import afterwards, see DeviceManager.importExternal).
 */
export async function storeFitInputs(
  db: SqlExecutor,
  files: FitInput[],
  target: ImportTarget,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportReport> {
  const report: ImportReport = { found: files.length, added: 0, duplicates: 0, invalid: [], touched: new Map(), createdDevice: null, matchedBySerial: 0 };
  const owner = await getUser(db, target.userId);
  if (!owner || owner.is_demo) throw new Error("I file di un bracciale reale non si possono importare nel profilo Demo: torna ai tuoi dati e riprova");
  const devices = (await listDevices(db, target.userId)).filter((d) => !d.is_demo);
  const bySerial = new Map(devices.filter((d) => d.unit_number).map((d) => [d.unit_number!, d]));
  let fallback: Device | null = target.fallbackDevice === "new" ? null : (devices.find((d) => d.id === target.fallbackDevice) ?? null);

  for (let i = 0; i < files.length; i++) {
    onProgress?.(i, files.length);
    const f = files[i];
    let data: Uint8Array;
    let info: { type: number; created: number | null; number: number; serial: string | null };
    try {
      data = await f.read();
      info = fileIdOf(data);
    } catch (e) {
      report.invalid.push({ name: f.name, error: (e as Error).message });
      continue;
    }
    // which device: the band's serial number if we know it, otherwise the chosen one
    let device = info.serial ? bySerial.get(info.serial) : undefined;
    if (device) report.matchedBySerial++;
    else {
      if (!fallback) {
        fallback = await addDevice(db, { user_id: target.userId, name: target.newDeviceName ?? "vívosmart 5", model: target.newDeviceName ?? "vívosmart 5" });
        report.createdDevice = fallback;
        if (info.serial) await db.run("UPDATE device SET unit_number = ? WHERE id = ? AND unit_number IS NULL", [info.serial, fallback.id]);
        if (info.serial) bySerial.set(info.serial, fallback);
      }
      device = fallback;
    }
    const date = info.created ?? f.mtime;
    const entry: DirectoryEntry = {
      fileIndex: 0,
      fileDataType: 128,
      fileSubType: info.type,
      fileNumber: info.number,
      specificFlags: 0,
      fileFlags: 0,
      fileSize: data.length,
      fileDate: date,
    };
    const res = await storeFitFile(db, device.id, entry, data, "gadgetbridge");
    if (res.duplicate) report.duplicates++;
    else {
      report.added++;
      const prev = report.touched.get(device.id);
      report.touched.set(device.id, prev === undefined ? date : Math.min(prev, date));
    }
  }
  onProgress?.(files.length, files.length);
  return report;
}

/** Reads the FIT file_id record: file type, creation time, number and the band's serial number. */
export function fileIdOf(data: Uint8Array) {
  const fit = decodeFit(data);
  const id = fit.records.find((r) => r.name === "file_id");
  if (!id) throw new Error("file FIT senza intestazione file_id");
  const type = num(id.fields.type);
  if (type === null) throw new Error("tipo di file FIT mancante");
  const serial = num(id.fields.serial_number);
  return {
    type,
    created: num(id.fields.time_created),
    number: num(id.fields.number) ?? 0,
    serial: serial !== null ? String(serial) : null,
  };
}
