/**
 * Connects Garmin sessions (real BLE or the demo simulator) to the local database.
 * Mirrors what Gadgetbridge's DeviceService does for one or more devices.
 */
import { importFit } from "./db/importer";
import {
  addDevice,
  deleteAllSamples,
  findDeviceByBleId,
  fitFileExists,
  getDevice,
  insertFitFile,
  markFitProcessed,
  recordBattery,
  updateDevice,
  type Device,
  type DeviceSettings,
} from "./db/repo";
import type { SqlExecutor } from "./db/sql";
import { FakeWatch } from "./demo/fake-watch";
import { generateDemoFiles } from "./demo/generator";
import type { RealtimeUpdate } from "./garmin/multilink";
import { GarminSession, type SessionState, type SyncProgress } from "./garmin/session";
import { WebBluetoothTransport, getPermittedDevices, requestGarminDevice, type BleTransport } from "./garmin/transport";
import { scanImport, storeFitInputs, type FitInput, type ImportReport, type ImportTarget } from "./gb-import";
import { LiveRecorder } from "./live-recorder";
import { log } from "./log";

export type ConnState = SessionState | "idle";

/** Latest values received on the band's live channels. */
export interface RealtimeState extends RealtimeUpdate {
  /** unix seconds of the last update */
  updatedAt: number;
  /** heart rate readings of the last 30 minutes, for the live sparkline */
  hrHistory: { timestamp: number; value: number }[];
}

export interface LiveState {
  state: ConnState;
  progress: SyncProgress | null;
  battery: number | null;
  /** latest live heart rate (kept for compatibility, same as realtime.heartRate) */
  liveHr: number | null;
  /** null when the live channels are closed */
  realtime: RealtimeState | null;
  error: string | null;
  findingPhone: boolean;
}

const IDLE: LiveState = { state: "idle", progress: null, battery: null, liveHr: null, realtime: null, error: null, findingPhone: false };

export interface SyncReport {
  deviceId: number;
  startedAt: number;
  finishedAt: number | null;
  directory: { index: number; type: string; size: number; date: number | null; queued: boolean }[] | null;
  downloaded: number;
  skipped: number;
  failed: number;
  imported: { fileId: number; type: string | null; counts: Record<string, number>; warning?: string; error?: string }[];
}

export const DEFAULT_SETTINGS: Required<DeviceSettings> = {
  keepOnDevice: false,
  fetchUnknownFiles: false,
  capabilityProfile: "gadgetbridge",
  maxWriteSize: 20,
  syncTimeOnConnect: true,
  autoSyncOnConnect: true,
  liveOnConnect: true,
  liveSpo2: false,
  autoSyncMinutes: 15,
  paired: false,
};

const L = log("device");

function hostInfo() {
  const ua = navigator.userAgent;
  const android = /Android/i.test(ua);
  const model = android ? (ua.match(/Android [^;]+; ([^;)]+)/)?.[1] ?? "Android") : navigator.platform || "Browser";
  return { name: "VitaBridge", manufacturer: android ? "Android" : "Web", model };
}

export class DeviceManager {
  private sessions = new Map<number, { session: GarminSession; transport: BleTransport }>();
  private live = new Map<number, LiveState>();
  private listeners = new Set<() => void>();
  private snapshot = new Map<number, LiveState>();
  private importing = new Set<number>();
  /** stores the live channels per minute into live_sample, per device */
  private recorders = new Map<number, LiveRecorder>();
  private reports = new Map<number, SyncReport>();
  /** periodic sync timers per connected device */
  private timers = new Map<number, ReturnType<typeof setInterval>>();
  private visibilityHooked = false;
  /** last sync report per device (for the diagnostics in the Log page) */
  getReport = (deviceId: number) => this.reports.get(deviceId);
  allReports = () => [...this.reports.values()];
  /** bumps after data changes, used to refresh queries */
  dataVersion = 0;
  onDataChanged: (() => void) | null = null;
  onFindPhone: ((start: boolean) => void) | null = null;
  /** result of a sync started by the user (not the automatic ones) */
  onManualSyncDone: ((deviceId: number, r: { downloaded: number; skipped: number; failed: number; listed: number | null }) => void) | null = null;
  private manualSync = new Set<number>();

  constructor(private db: SqlExecutor, private userId: () => number) {}

  // ------------------------------------------------------------ store API
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getSnapshot = () => this.snapshot;
  get(deviceId: number): LiveState {
    return this.snapshot.get(deviceId) ?? IDLE;
  }
  private patch(deviceId: number, p: Partial<LiveState>) {
    this.live.set(deviceId, { ...(this.live.get(deviceId) ?? IDLE), ...p });
    this.snapshot = new Map(this.live);
    this.listeners.forEach((l) => l());
  }
  private dataChanged() {
    this.dataVersion++;
    this.onDataChanged?.();
  }

  isConnected(deviceId: number) {
    const s = this.get(deviceId).state;
    return s === "ready" || s === "syncing" || s === "initializing" || s === "connecting";
  }

  // ------------------------------------------------------------ pairing / connecting

  /** Opens the browser chooser, connects and stores the device. Must be called from a click. */
  async pairNew(showAll = false): Promise<Device> {
    const ble = await requestGarminDevice(showAll);
    const existing = await findDeviceByBleId(this.db, ble.id);
    const device =
      existing ??
      (await addDevice(this.db, {
        user_id: this.userId(),
        name: ble.name ?? "Garmin",
        model: ble.name ?? undefined,
        ble_id: ble.id,
        settings: { ...DEFAULT_SETTINGS },
      }));
    this.dataChanged();
    await this.connectBle(device, ble);
    return device;
  }

  async addDemo(): Promise<Device> {
    const device = await addDevice(this.db, {
      user_id: this.userId(),
      name: "vívosmart 5",
      model: "vívosmart 5 (demo)",
      ble_id: `demo-${Date.now()}`,
      is_demo: true,
      settings: { ...DEFAULT_SETTINGS },
    });
    this.dataChanged();
    await this.connect(device);
    return device;
  }

  async connect(device: Device) {
    if (this.sessions.has(device.id)) return;
    if (device.is_demo) {
      // A simulated band with the files written since the last sync (or the last 14 days).
      // Each day's data is deterministic (same seed), so later syncs continue the same day.
      const seed = device.id * 1000;
      const days = device.last_sync ? Math.max(1, Math.ceil((Date.now() / 1000 - device.last_sync) / 86400) + 1) : 14;
      const files = generateDemoFiles({ days: Math.min(days, 30), seed }).filter((f) => !device.last_sync || f.date > device.last_sync);
      let lastWritten = Math.floor(Date.now() / 1000);
      const watch = new FakeWatch({
        files,
        battery: 60 + Math.round(Math.random() * 35),
        mtu: 244,
        // like a real band, it keeps recording: every sync finds today's monitoring file updated to "now"
        newFiles: () => {
          const now = Math.floor(Date.now() / 1000);
          if (now - lastWritten < 30) return [];
          const fresh = generateDemoFiles({ days: 1, seed }).filter((f) => f.subType === 32 || (f.subType === 4 && f.date > lastWritten));
          lastWritten = now;
          return fresh;
        },
      });
      await this.startSession(device, watch);
      return;
    }
    const permitted = await getPermittedDevices();
    const ble = permitted.find((d) => d.id === device.ble_id);
    if (!ble) {
      // Chrome forgets permissions in some setups: ask the user to pick it again
      const picked = await requestGarminDevice(false);
      await updateDevice(this.db, device.id, { ble_id: picked.id });
      await this.connectBle({ ...device, ble_id: picked.id }, picked);
      return;
    }
    await this.connectBle(device, ble);
  }

  private async connectBle(device: Device, ble: BluetoothDevice) {
    this.patch(device.id, { state: "connecting", error: null });
    try {
      const transport = await WebBluetoothTransport.connect(ble, (m) => L.info(m));
      await this.startSession(device, transport);
    } catch (e) {
      const msg = (e as Error).message;
      L.error(`Connessione fallita: ${msg}`);
      this.patch(device.id, { state: "idle", error: msg });
      throw e;
    }
  }

  private async startSession(device: Device, transport: BleTransport) {
    const settings = { ...DEFAULT_SETTINGS, ...device.settings };
    const S = log(device.alias || device.name);
    const id = device.id;
    const session = new GarminSession(
      transport,
      {
        log: (level, msg) => S[level](msg),
        onState: (state) => {
          this.patch(id, { state });
          if (state === "disconnected") {
            void this.closeRecorder(id);
            this.stopTimer(id);
            this.sessions.delete(id);
            this.patch(id, { state: "idle", progress: null, liveHr: null, realtime: null });
          }
        },
        onDeviceInfo: (info) => {
          void updateDevice(this.db, id, {
            model: info.deviceModel,
            firmware: info.softwareVersionStr,
            product_number: info.productNumber,
            unit_number: info.unitNumber,
          });
        },
        onBattery: (level) => {
          this.patch(id, { battery: level });
          void recordBattery(this.db, id, level).then(() => this.dataChanged());
        },
        onProgress: (progress) => this.patch(id, { progress }),
        onRealtime: (u) => this.onRealtime(id, device.user_id, u),
        onDirectory: (entries) => {
          const r = this.reports.get(id);
          if (r) r.directory = entries.map((e) => ({ index: e.fileIndex, type: e.typeName, size: e.fileSize, date: e.fileDate, queued: e.queued }));
        },
        onFindPhone: (start) => {
          this.patch(id, { findingPhone: start });
          this.onFindPhone?.(start);
        },
        isAlreadyDownloaded: (entry) => fitFileExists(this.db, id, entry),
        onFileDownloaded: async (entry, data) => {
          await insertFitFile(this.db, id, entry, data);
        },
        onSyncFinished: async (stats) => {
          const r = this.reports.get(id);
          if (r) Object.assign(r, { downloaded: stats.downloaded, skipped: stats.skipped, failed: stats.failed });
          await this.processPendingFiles(id);
          if (transport instanceof FakeWatch) await this.alignDemoCounters(transport, device.user_id);
          if (r) r.finishedAt = Math.floor(Date.now() / 1000);
          if (this.manualSync.delete(id)) this.onManualSyncDone?.(id, { ...stats, listed: r?.directory?.length ?? null });
          await updateDevice(this.db, id, { last_sync: Math.floor(Date.now() / 1000) });
          S.info(`Sync: ${stats.downloaded} nuovi file, ${stats.skipped} già presenti, ${stats.failed} errori`);
          this.dataChanged();
        },
      },
      {
        capabilityProfile: settings.capabilityProfile,
        keepOnDevice: settings.keepOnDevice,
        fetchUnknownFiles: settings.fetchUnknownFiles,
        firstConnect: !settings.paired,
        maxWriteSize: settings.maxWriteSize,
        syncTimeOnConnect: settings.syncTimeOnConnect,
        host: hostInfo(),
      },
    );
    this.sessions.set(id, { session, transport });
    this.patch(id, { state: "connecting", error: null });
    await session.start();
    const ok = await session.waitReady(30_000);
    if (!ok) {
      S.error("Il dispositivo non ha completato l'inizializzazione entro 30 s");
      this.patch(id, { error: "Inizializzazione non completata (vedi log)" });
      await session.disconnect().catch(() => {});
      return;
    }
    if (!settings.paired) await updateDevice(this.db, id, { settings: { ...device.settings, paired: true } });
    if (settings.liveOnConnect) await this.setLive(id, true).catch((e) => S.warn(`Dati live non disponibili: ${(e as Error).message}`));
    this.startTimer(id, settings.autoSyncMinutes);
    if (settings.autoSyncOnConnect) await this.sync(id);
  }

  // ------------------------------------------------------------ live data / periodic sync

  /** Demo only: the simulated band's live step counter continues from today's imported steps, like a real band. */
  private async alignDemoCounters(watch: FakeWatch, userId: number) {
    const d = new Date();
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
    const row = (await this.db.all<{ s: number | null }>("SELECT SUM(steps) AS s FROM activity_sample WHERE user_id = ? AND timestamp >= ?", [userId, from]))[0];
    watch.liveSteps = Math.max(watch.liveSteps, row?.s ?? 0);
  }

  private onRealtime(deviceId: number, userId: number, u: RealtimeUpdate) {
    const now = Math.floor(Date.now() / 1000);
    const prev = this.get(deviceId).realtime ?? { updatedAt: now, hrHistory: [] };
    const hrHistory = u.heartRate
      ? [...prev.hrHistory.filter((p) => p.timestamp > now - 1800), { timestamp: now, value: u.heartRate }]
      : prev.hrHistory;
    this.patch(deviceId, { realtime: { ...prev, ...u, updatedAt: now, hrHistory }, ...(u.heartRate ? { liveHr: u.heartRate } : {}) });
    let rec = this.recorders.get(deviceId);
    if (!rec) {
      rec = new LiveRecorder(this.db, deviceId, userId, () => this.dataChanged());
      this.recorders.set(deviceId, rec);
    }
    void rec.push(u);
  }

  private async closeRecorder(deviceId: number) {
    const rec = this.recorders.get(deviceId);
    this.recorders.delete(deviceId);
    await rec?.close();
  }

  /** Opens/closes the band's live channels (heart rate, steps, Body Battery, SpO2, respiration, floors). */
  async setLive(id: number, enable: boolean) {
    const device = await getDevice(this.db, id);
    await this.requireSession(id).setRealtime(enable, { ...DEFAULT_SETTINGS, ...device?.settings }.liveSpo2);
    if (enable) {
      if (!this.get(id).realtime) this.patch(id, { realtime: { updatedAt: Math.floor(Date.now() / 1000), hrHistory: [] } });
    } else {
      this.patch(id, { liveHr: null, realtime: null });
      await this.closeRecorder(id);
    }
  }

  /** While connected, downloads the band's new files every N minutes so history and charts stay current. */
  private startTimer(id: number, minutes: number) {
    this.stopTimer(id);
    if (minutes > 0) {
      this.timers.set(
        id,
        setInterval(() => {
          if (this.sessions.get(id)?.session.state === "ready") void this.sync(id).catch(() => {});
        }, minutes * 60_000),
      );
    }
    if (!this.visibilityHooked && typeof document !== "undefined") {
      this.visibilityHooked = true;
      // back to the app after a while: catch up right away
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        for (const [devId, { session }] of this.sessions) {
          const last = this.reports.get(devId)?.startedAt ?? 0;
          if (session.state === "ready" && Date.now() / 1000 - last > 300) void this.sync(devId).catch(() => {});
        }
      });
    }
  }

  private stopTimer(id: number) {
    const t = this.timers.get(id);
    if (t) clearInterval(t);
    this.timers.delete(id);
  }

  /** Applies changed live/auto-sync settings to a connected device. */
  async applySettings(id: number, s: DeviceSettings) {
    if (!this.sessions.has(id)) return;
    const merged = { ...DEFAULT_SETTINGS, ...s };
    this.startTimer(id, merged.autoSyncMinutes);
    await this.setLive(id, merged.liveOnConnect);
  }

  async disconnect(deviceId: number) {
    const s = this.sessions.get(deviceId);
    if (s) await s.session.disconnect();
    this.sessions.delete(deviceId);
    this.stopTimer(deviceId);
    this.patch(deviceId, { state: "idle", progress: null, liveHr: null, realtime: null });
  }

  private requireSession(deviceId: number) {
    const s = this.sessions.get(deviceId);
    if (!s) throw new Error("Dispositivo non connesso");
    return s.session;
  }

  async sync(deviceId: number, manual = false) {
    const session = this.requireSession(deviceId);
    if (session.state !== "ready") return;
    if (manual) this.manualSync.add(deviceId);
    this.reports.set(deviceId, {
      deviceId, startedAt: Math.floor(Date.now() / 1000), finishedAt: null, directory: null, downloaded: 0, skipped: 0, failed: 0, imported: [],
    });
    await session.fetchRecordedData();
  }

  findDevice = (id: number, start: boolean) => this.requireSession(id).findDevice(start);
  setTime = (id: number) => this.requireSession(id).setTime();
  refreshBattery = (id: number) => this.requireSession(id).requestBattery();
  /** @deprecated use setLive: the band exposes all live channels together */
  setLiveHeartRate = (id: number, enable: boolean) => this.setLive(id, enable);

  // ------------------------------------------------------------ importing

  /** Imports downloaded FIT files not processed yet, oldest first (monitoring deltas need chronological order). */
  async processPendingFiles(deviceId: number) {
    if (this.importing.has(deviceId)) return;
    this.importing.add(deviceId);
    try {
      const device = await getDevice(this.db, deviceId);
      if (!device) return;
      const pending = await this.db.all<{ id: number }>(
        "SELECT id FROM fit_file WHERE device_id = ? AND processed_at IS NULL ORDER BY file_date, id",
        [deviceId],
      );
      let i = 0;
      for (const { id } of pending) {
        const row = (await this.db.all<{ data: Uint8Array; file_type: string | null }>("SELECT data, file_type FROM fit_file WHERE id = ?", [id]))[0];
        this.patch(deviceId, { progress: { phase: "processing", filesDone: i++, filesTotal: pending.length, bytesDone: 0, bytesTotal: 0 } });
        try {
          const res = await importFit(this.db, { deviceId, userId: device.user_id, fitFileId: id }, row.data);
          await markFitProcessed(this.db, id, res.warning ? `parziale: ${res.warning}` : null);
          const summary = Object.entries(res.counts).map(([k, v]) => `${k}=${v}`).join(", ") || "nessun dato riconosciuto";
          (res.warning ? L.warn : L.info)(`File ${id} (FIT tipo ${res.fileType ?? "?"}) importato: ${summary}${res.warning ? ` – letto solo in parte: ${res.warning}` : ""}`);
          this.reports.get(deviceId)?.imported.push({ fileId: id, type: row.file_type, counts: res.counts, warning: res.warning });
        } catch (e) {
          L.error(`Importazione file ${id} fallita: ${(e as Error).message}`);
          await markFitProcessed(this.db, id, (e as Error).message);
          this.reports.get(deviceId)?.imported.push({ fileId: id, type: row.file_type, counts: {}, error: (e as Error).message });
        }
      }
    } finally {
      this.importing.delete(deviceId);
    }
  }

  /** Re-imports every stored FIT file of a device from scratch (like Gadgetbridge's "reprocess files"). */
  async reprocessAll(deviceId: number) {
    await deleteAllSamples(this.db, deviceId);
    await this.db.run("UPDATE fit_file SET processed_at = NULL, error = NULL WHERE device_id = ?", [deviceId]);
    await this.processPendingFiles(deviceId);
    this.patch(deviceId, { progress: null });
    this.dataChanged();
  }

  /** Imports .fit files picked by the user (e.g. copied from the band via USB) into this device. */
  async importFiles(deviceId: number, files: File[]) {
    const scan = await scanImport(files);
    const device = await getDevice(this.db, deviceId);
    return this.importExternal(scan.fitFiles, { userId: device?.user_id ?? this.userId(), fallbackDevice: deviceId });
  }

  /**
   * Imports FIT files coming from outside the band connection (Gadgetbridge export, loose files):
   * stores them (skipping identical files) and imports them into the chart tables in date order.
   * If they are older than data already imported for that device, the device's data is rebuilt
   * from all its files, so the per-day counters stay correct whatever order things arrive in.
   */
  async importExternal(files: FitInput[], target: ImportTarget, onProgress?: (phase: "store" | "import", done: number, total: number) => void): Promise<ImportReport> {
    const report = await storeFitInputs(this.db, files, target, (d, t) => onProgress?.("store", d, t));
    let i = 0;
    for (const [deviceId, earliest] of report.touched) {
      onProgress?.("import", i++, report.touched.size);
      const latest = (
        await this.db.all<{ m: number | null }>(
          "SELECT MAX(file_date) AS m FROM fit_file WHERE device_id = ? AND processed_at IS NOT NULL AND sub_type IN (15, 28, 32)",
          [deviceId],
        )
      )[0]?.m;
      if (latest != null && earliest < latest) {
        L.info(`File importati più vecchi dei dati già presenti: ricostruisco i dati del dispositivo ${deviceId} da tutti i suoi file`);
        await this.reprocessAll(deviceId);
      } else {
        await this.processPendingFiles(deviceId);
        this.patch(deviceId, { progress: null });
      }
    }
    onProgress?.("import", report.touched.size, report.touched.size);
    L.info(`Importazione: ${report.found} file trovati, ${report.added} nuovi, ${report.duplicates} già presenti, ${report.invalid.length} non validi`);
    this.dataChanged();
    return report;
  }

  async disconnectAll() {
    for (const id of [...this.sessions.keys()]) await this.disconnect(id);
  }
}
