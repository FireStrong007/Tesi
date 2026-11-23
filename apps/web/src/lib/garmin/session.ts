/**
 * GarminSession: drives a connected Garmin band over GFDI.
 *  - handshake (device information, configuration/capabilities, time)
 *  - battery status
 *  - file sync: directory download, FIT file downloads, archive flag
 *  - find my watch
 *
 * The flow follows Gadgetbridge's GarminSupport / FileTransferHandler (AGPL-3.0)
 * with the default (legacy) sync protocol and plain Multi-Link.
 */
import { hex } from "../bytes";
import { capabilitiesFromBinary, capabilitiesToBinary, ourCapabilities, type Capability, type CapabilityProfile } from "./capabilities";
import { crc16 } from "./crc";
import { fileTypeOf, shouldDownload } from "./filetypes";
import {
  DownloadStatus,
  FileFlag,
  FilterType,
  Msg,
  MsgName,
  Status,
  SystemEvent,
  TransferStatus,
  out,
  parseBatteryStatus,
  parseConfiguration,
  parseDeviceInformation,
  parseDirectory,
  parseDirectoryEntry,
  parseFileTransferData,
  parseMessage,
  parseProtobuf,
  parseStatus,
  parseSupportedFileTypes,
  parseSynchronization,
  syncShouldProceed,
  type DeviceInformation,
  type DirectoryEntry,
  type SupportedFileType,
} from "./gfdi";
import { LIVE_SERVICES, LIVE_SPO2, MlService, MultiLink, type RealtimeUpdate } from "./multilink";
import { parseSmartBattery, smartBatteryRequest, smartFindWatch, smartFindWatchCancel } from "./protobuf";
import type { BleTransport } from "./transport";

export type SessionState = "connecting" | "initializing" | "ready" | "syncing" | "disconnected";

export interface SyncProgress {
  phase: "directory" | "download" | "processing" | "done";
  fileIndex?: number;
  fileName?: string;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

export interface SessionHooks {
  log(level: "debug" | "info" | "warn" | "error", msg: string): void;
  onState?(s: SessionState): void;
  onDeviceInfo?(info: DeviceInformation): void;
  onBattery?(level: number, status?: string): void;
  onProgress?(p: SyncProgress): void;
  /** full directory listing of the band, for diagnostics */
  onDirectory?(entries: (DirectoryEntry & { typeName: string; queued: boolean })[]): void;
  onRealtime?(update: RealtimeUpdate): void;
  onFindPhone?(start: boolean): void;
  /** Return true if this directory entry was already stored, to skip the download. */
  isAlreadyDownloaded?(entry: DirectoryEntry): Promise<boolean>;
  /** Called with every downloaded FIT file. Should persist + import it. */
  onFileDownloaded?(entry: DirectoryEntry, data: Uint8Array): Promise<void>;
  /** Called after all files of a sync have been handled. */
  onSyncFinished?(stats: { downloaded: number; skipped: number; failed: number }): Promise<void> | void;
}

export interface SessionOptions {
  capabilityProfile: CapabilityProfile;
  /** keep files on the band (do not set the ARCHIVE flag) */
  keepOnDevice: boolean;
  /** also download FIT file types not imported by default */
  fetchUnknownFiles: boolean;
  /** first connection after pairing: sends PAIR_COMPLETE / SETUP_WIZARD_COMPLETE */
  firstConnect: boolean;
  maxWriteSize: number;
  syncTimeOnConnect: boolean;
  host: { name: string; manufacturer: string; model: string };
}

interface CurrentDownload {
  entry: DirectoryEntry;
  isDirectory: boolean;
  size: number;
  data: Uint8Array | null;
  offset: number;
  crc: number;
  lastActivity: number;
}

const DIRECTORY_ENTRY: DirectoryEntry = {
  fileIndex: 0,
  fileDataType: 0,
  fileSubType: 0,
  fileNumber: 0,
  specificFlags: 0,
  fileFlags: 0,
  fileSize: 0,
  fileDate: null,
};

export class GarminSession {
  readonly ml: MultiLink;
  state: SessionState = "connecting";
  deviceInfo: DeviceInformation | null = null;
  deviceCapabilities = new Set<Capability>();
  supportedFileTypes: SupportedFileType[] = [];
  battery: number | null = null;

  private queue: DirectoryEntry[] = [];
  private current: CurrentDownload | null = null;
  private fetching = false;
  private stats = { downloaded: 0, skipped: 0, failed: 0 };
  private progress: SyncProgress = { phase: "done", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 };
  private protobufRequestId = 0;
  private protobufBuffers = new Map<number, Uint8Array>();
  private incoming: Uint8Array[] = [];
  private processing = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readyWaiters: ((ok: boolean) => void)[] = [];
  private initialized = false;

  constructor(private transport: BleTransport, private hooks: SessionHooks, private opts: SessionOptions) {
    this.ml = new MultiLink(transport, {
      onGfdiReady: () => {
        this.setState("initializing");
        this.hooks.log("info", "Canale GFDI aperto, attendo informazioni dispositivo");
      },
      onGfdiMessage: (m) => this.enqueue(m),
      onRealtime: (u) => this.hooks.onRealtime?.(u),
      log: (m) => this.hooks.log("debug", m),
    });
    this.ml.maxWriteSize = opts.maxWriteSize;
    transport.onDisconnect(() => this.onDisconnected());
  }

  async start() {
    this.setState("connecting");
    await this.ml.start();
    this.watchdog = setInterval(() => this.checkStall(), 5000);
  }

  /** Resolves when the handshake is complete (state "ready"). */
  waitReady(timeoutMs = 30_000): Promise<boolean> {
    if (this.initialized) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.readyWaiters.push((ok) => {
        clearTimeout(t);
        resolve(ok);
      });
    });
  }

  async disconnect() {
    await this.transport.disconnect();
    this.onDisconnected();
  }

  private onDisconnected() {
    if (this.state === "disconnected") return;
    if (this.watchdog) clearInterval(this.watchdog);
    this.setState("disconnected");
    this.readyWaiters.splice(0).forEach((w) => w(false));
    if (this.fetching) {
      this.hooks.log("warn", "Disconnesso durante la sincronizzazione");
      this.fetching = false;
      this.current = null;
      this.queue = [];
    }
  }

  private setState(s: SessionState) {
    this.state = s;
    this.hooks.onState?.(s);
  }

  private async send(name: string, msg: Uint8Array | null) {
    if (!msg) return;
    this.hooks.log("debug", `→ ${name}: ${hex(msg, 64)}`);
    await this.ml.sendGfdi(msg);
  }

  // ---------------------------------------------------------------- public API

  /** Starts a full sync: like Gadgetbridge's onFetchRecordedData. */
  async fetchRecordedData() {
    if (this.state !== "ready") throw new Error("Dispositivo non pronto");
    await this.requestBattery();
    this.beginFetching();
    this.current = this.newDownload(DIRECTORY_ENTRY, true);
    this.progress = { phase: "directory", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 };
    this.hooks.onProgress?.({ ...this.progress });
    await this.send("richiesta directory", out.downloadRequest(0));
  }

  async requestBattery() {
    await this.sendProtobuf("batteria", smartBatteryRequest());
  }

  async setTime() {
    await this.send("aggiorna ora", out.systemEvent(SystemEvent.TIME_UPDATED, 0));
  }

  async findDevice(start: boolean) {
    await this.sendProtobuf(start ? "trova dispositivo" : "annulla trova", start ? smartFindWatch(60) : smartFindWatchCancel());
  }

  /** Opens (or closes) the band's live channels: heart rate, steps, Body Battery, SpO2, respiration, floors. */
  async setRealtime(enable: boolean, spo2 = false) {
    const want = new Set<MlService>(enable ? [...LIVE_SERVICES, ...(spo2 ? [LIVE_SPO2] : [])] : []);
    for (const s of [...LIVE_SERVICES, LIVE_SPO2]) {
      if (want.has(s) && !this.ml.isRegistered(s)) await this.ml.registerService(s);
      if (!want.has(s) && this.ml.isRegistered(s)) await this.ml.closeService(s);
    }
  }

  get realtimeActive() {
    return this.ml.isRegistered(MlService.REALTIME_HR) || this.ml.isRegistered(MlService.REALTIME_STEPS);
  }

  private async sendProtobuf(name: string, payload: Uint8Array) {
    const id = this.protobufRequestId++ & 0xffff;
    await this.send(`protobuf ${name}`, out.protobufRequest(id, payload));
  }

  // ---------------------------------------------------------------- incoming

  private enqueue(m: Uint8Array) {
    this.incoming.push(m);
    if (!this.processing) void this.drain();
  }

  private async drain() {
    this.processing = true;
    try {
      while (this.incoming.length) {
        const m = this.incoming.shift()!;
        try {
          await this.handle(m);
        } catch (e) {
          this.hooks.log("error", `Errore gestendo messaggio ${hex(m, 48)}: ${(e as Error).message}`);
        }
        try {
          await this.processDownloadQueue();
        } catch (e) {
          this.hooks.log("error", `Errore coda download: ${(e as Error).message}`);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async handle(bytes: Uint8Array) {
    const msg = parseMessage(bytes);
    const r = msg.reader;
    const name = MsgName[msg.type] ?? String(msg.type);
    if (msg.type !== Msg.FILE_TRANSFER_DATA) this.hooks.log("debug", `← ${name}: ${hex(bytes, 64)}`);

    switch (msg.type) {
      case Msg.RESPONSE:
        await this.handleStatus(r);
        return;

      case Msg.DEVICE_INFORMATION: {
        const info = parseDeviceInformation(r);
        this.deviceInfo = info;
        this.hooks.log("info", `Dispositivo: ${info.deviceName} (${info.deviceModel}), firmware ${info.softwareVersionStr}, max packet ${info.maxPacketSize}`);
        this.hooks.onDeviceInfo?.(info);
        await this.send("ack device info", out.status(Msg.DEVICE_INFORMATION));
        await this.send("risposta device info", out.deviceInformationResponse(info.protocolVersion, this.opts.host));
        return;
      }

      case Msg.CONFIGURATION: {
        this.deviceCapabilities = capabilitiesFromBinary(parseConfiguration(r));
        this.hooks.log("info", `Capacità dispositivo: ${this.deviceCapabilities.size}`);
        await this.send("ack configurazione", out.status(Msg.CONFIGURATION));
        await this.send("nostra configurazione", out.configuration(capabilitiesToBinary(ourCapabilities(this.opts.capabilityProfile))));
        await this.completeInitialization();
        return;
      }

      case Msg.CURRENT_TIME_REQUEST: {
        const ref = r.u32();
        await this.send("ora corrente", out.currentTimeResponse(ref));
        return;
      }

      case Msg.SYNCHRONIZATION: {
        const s = parseSynchronization(r);
        await this.send("ack sync", out.status(Msg.SYNCHRONIZATION));
        if (s && syncShouldProceed(s) && !this.fetching) {
          this.hooks.log("info", "Il dispositivo chiede una sincronizzazione");
          await this.send("filtro", out.filter(FilterType.ONLY_NEW));
        }
        return;
      }

      case Msg.FILE_AVAILABLE: {
        const entry = parseDirectoryEntry(r);
        await this.send("ack file disponibile", out.status(Msg.FILE_AVAILABLE));
        this.conditionallyQueue(entry);
        return;
      }

      case Msg.FILE_TRANSFER_DATA:
        await this.handleFileData(parseFileTransferData(r));
        return;

      case Msg.BATTERY_STATUS: {
        const b = parseBatteryStatus(r);
        await this.send("ack batteria", out.status(Msg.BATTERY_STATUS));
        this.battery = b.percent;
        this.hooks.onBattery?.(b.percent, b.status);
        return;
      }

      case Msg.PROTOBUF_REQUEST:
      case Msg.PROTOBUF_RESPONSE: {
        const chunk = parseProtobuf(r);
        const complete = chunk.dataOffset === 0 && chunk.totalLength === chunk.chunkLength;
        if (complete) await this.send("ack protobuf", out.status(msg.type));
        else await this.send("ack protobuf chunk", out.protobufStatus(msg.type, chunk.requestId, chunk.dataOffset));
        const full = this.collectProtobuf(chunk);
        if (full) this.handleSmart(full);
        return;
      }

      case Msg.NOTIFICATION_SUBSCRIPTION: {
        const enable = r.u8() === 1;
        const unk = r.remaining() > 0 ? r.u8() : 0;
        await this.send("stato notifiche", out.notificationSubscriptionStatus(enable, unk));
        return;
      }

      case Msg.AUTH_NEGOTIATION: {
        const unk = r.u8();
        const flags = r.u32();
        await this.send("auth", out.authNegotiationStatus(unk, flags));
        return;
      }

      case Msg.WEATHER_REQUEST:
        await this.send("ack meteo", out.status(Msg.WEATHER_REQUEST));
        return;

      case Msg.FIND_MY_PHONE_REQUEST:
        await this.send("ack trova telefono", out.status(msg.type));
        this.hooks.onFindPhone?.(true);
        return;

      case Msg.FIND_MY_PHONE_CANCEL:
        await this.send("ack annulla trova telefono", out.status(msg.type));
        this.hooks.onFindPhone?.(false);
        return;

      case Msg.MUSIC_CONTROL:
        await this.send("ack musica", out.status(msg.type));
        return;

      default:
        // Gadgetbridge does not answer unknown messages
        this.hooks.log("debug", `Messaggio non gestito ${name}`);
    }
  }

  private async completeInitialization() {
    if (this.initialized) {
      this.hooks.log("warn", "Inizializzazione già completata");
      return;
    }
    await this.send("tipi file supportati", out.supportedFileTypesRequest());
    await this.send("impostazioni", out.deviceSettings({ autoUpload: true, weatherConditions: true, weatherAlerts: false }));
    if (this.opts.syncTimeOnConnect) await this.setTime();
    await this.send("sync ready", out.systemEvent(SystemEvent.SYNC_READY, 0));
    await this.requestBattery();
    this.initialized = true;
    this.setState("ready");
    this.readyWaiters.splice(0).forEach((w) => w(true));
    if (this.opts.firstConnect) {
      await this.send("pair complete", out.systemEvent(SystemEvent.PAIR_COMPLETE, 0));
      await this.send("sync complete", out.systemEvent(SystemEvent.SYNC_COMPLETE, 0));
      await this.send("setup wizard complete", out.systemEvent(SystemEvent.SETUP_WIZARD_COMPLETE, 0));
      this.opts.firstConnect = false;
    }
    this.hooks.log("info", "Dispositivo inizializzato");
  }

  private async handleStatus(r: import("../bytes").ByteReader) {
    const st = parseStatus(r);
    switch (st.originalType) {
      case Msg.DOWNLOAD_REQUEST: {
        if (st.status !== Status.ACK) {
          this.failCurrent(`download rifiutato (status ${Status[st.status]})`);
          return;
        }
        const dl = st.reader.u8() as DownloadStatus;
        const maxFileSize = st.reader.u32();
        if (!this.current) return;
        if (dl !== DownloadStatus.OK) {
          this.failCurrent(`download non possibile: ${DownloadStatus[dl] ?? dl}`);
          return;
        }
        this.current.size = maxFileSize;
        this.current.data = new Uint8Array(maxFileSize);
        this.current.lastActivity = Date.now();
        if (maxFileSize === 0) await this.completeDownload();
        return;
      }
      case Msg.SUPPORTED_FILE_TYPES_REQUEST:
        if (st.status === Status.ACK) {
          this.supportedFileTypes = parseSupportedFileTypes(st.reader);
          this.hooks.log("info", `Tipi file supportati: ${this.supportedFileTypes.map((t) => t.name).join(", ")}`);
        }
        return;
      case Msg.FILTER:
        // Like FileTransferHandler: once the filter is acknowledged, list the directory.
        if (!this.fetching) {
          this.beginFetching();
          this.current = this.newDownload(DIRECTORY_ENTRY, true);
          this.progress = { phase: "directory", filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 };
          this.hooks.onProgress?.({ ...this.progress });
          await this.send("richiesta directory", out.downloadRequest(0));
        }
        return;
      case Msg.SET_FILE_FLAG:
      case Msg.PROTOBUF_REQUEST:
      case Msg.PROTOBUF_RESPONSE:
      default:
        if (st.status !== Status.ACK) this.hooks.log("warn", `Risposta ${Status[st.status]} a ${MsgName[st.originalType] ?? st.originalType}`);
    }
  }

  private collectProtobuf(c: { requestId: number; dataOffset: number; totalLength: number; data: Uint8Array }): Uint8Array | null {
    if (c.dataOffset === 0 && c.data.length === c.totalLength) return c.data;
    let buf = this.protobufBuffers.get(c.requestId);
    if (!buf || c.dataOffset === 0) {
      buf = new Uint8Array(c.totalLength);
      this.protobufBuffers.set(c.requestId, buf);
    }
    buf.set(c.data, c.dataOffset);
    if (c.dataOffset + c.data.length >= c.totalLength) {
      this.protobufBuffers.delete(c.requestId);
      return buf;
    }
    return null;
  }

  private handleSmart(smart: Uint8Array) {
    try {
      const b = parseSmartBattery(smart);
      if (b?.level !== undefined) {
        this.battery = b.level;
        this.hooks.onBattery?.(b.level, b.status !== undefined ? String(b.status) : undefined);
        this.hooks.log("info", `Batteria ${b.level}%`);
      }
    } catch (e) {
      this.hooks.log("debug", `Protobuf non interpretato: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- file sync

  private beginFetching() {
    this.fetching = true;
    this.stats = { downloaded: 0, skipped: 0, failed: 0 };
    this.setState("syncing");
  }

  private newDownload(entry: DirectoryEntry, isDirectory: boolean): CurrentDownload {
    return { entry, isDirectory, size: 0, data: null, offset: 0, crc: 0, lastActivity: Date.now() };
  }

  private conditionallyQueue(entry: DirectoryEntry) {
    if (!shouldDownload(entry.fileDataType, entry.fileSubType, this.opts.fetchUnknownFiles)) return;
    if (this.queue.some((q) => q.fileIndex === entry.fileIndex) || this.current?.entry.fileIndex === entry.fileIndex) return;
    this.queue.push(entry);
    this.progress.filesTotal++;
    this.progress.bytesTotal += entry.fileSize;
  }

  private async handleFileData(d: { crc: number; dataOffset: number; data: Uint8Array }) {
    const cur = this.current;
    if (!cur || !cur.data) {
      this.hooks.log("warn", "Dati file ricevuti senza download in corso");
      return;
    }
    if (d.dataOffset !== cur.offset) {
      this.hooks.log("warn", `Offset inatteso ${d.dataOffset} (atteso ${cur.offset})`);
      await this.send("ack offset", out.fileTransferDataAck(cur.offset, TransferStatus.OFFSET_MISMATCH));
      return;
    }
    const crc = crc16(d.data, cur.crc);
    if (crc !== d.crc) {
      this.hooks.log("warn", `CRC chunk non valido a offset ${d.dataOffset}`);
      await this.send("ack crc", out.fileTransferDataAck(cur.offset, TransferStatus.CRC_MISMATCH));
      return;
    }
    const room = Math.min(d.data.length, cur.size - cur.offset);
    cur.data.set(d.data.subarray(0, room), cur.offset);
    cur.offset += room;
    cur.crc = crc;
    cur.lastActivity = Date.now();
    await this.send("ack dati", out.fileTransferDataAck(cur.offset));
    if (!cur.isDirectory) {
      this.progress.bytesDone += room;
      this.hooks.onProgress?.({ ...this.progress });
    }
    if (cur.offset >= cur.size) await this.completeDownload();
  }

  private async completeDownload() {
    const cur = this.current!;
    const data = cur.data ?? new Uint8Array(0);
    if (cur.isDirectory) {
      const entries = parseDirectory(data);
      const listed: (DirectoryEntry & { typeName: string; queued: boolean })[] = [];
      for (const e of entries) {
        const t = fileTypeOf(e.fileDataType, e.fileSubType);
        const before = this.queue.length;
        this.conditionallyQueue(e);
        const typeName = t?.name ?? `${e.fileDataType}/${e.fileSubType}`;
        listed.push({ ...e, typeName, queued: this.queue.length > before });
        this.hooks.log("debug", `  #${e.fileIndex} ${typeName} ${e.fileSize}B ${e.fileDate ? new Date(e.fileDate * 1000).toISOString() : "-"} flags=${e.fileFlags.toString(16)}`);
      }
      const byType = new Map<string, number>();
      for (const l of listed) byType.set(l.typeName, (byType.get(l.typeName) ?? 0) + 1);
      this.hooks.log(
        "info",
        `Directory del bracciale: ${entries.length} file (${[...byType].map(([k, v]) => `${k}×${v}`).join(", ") || "vuota"}), da scaricare: ${listed.filter((l) => l.queued).length}`,
      );
      if (!entries.some((e) => e.fileDataType === 128))
        this.hooks.log("warn", "Il bracciale non ha elencato nessun file FIT: probabilmente non ha ancora salvato dati (riprova più tardi)");
      this.hooks.onDirectory?.(listed);
      this.current = null;
      this.progress.phase = "download";
      this.hooks.onProgress?.({ ...this.progress });
      return;
    }
    this.current = null;
    try {
      await this.hooks.onFileDownloaded?.(cur.entry, data);
      this.stats.downloaded++;
      if (!this.opts.keepOnDevice) await this.send(`archivia ${cur.entry.fileIndex}`, out.setFileFlags(cur.entry.fileIndex, FileFlag.ARCHIVE));
    } catch (e) {
      this.stats.failed++;
      this.hooks.log("error", `Errore salvando il file ${cur.entry.fileIndex}: ${(e as Error).message}`);
    }
    this.progress.filesDone++;
    this.hooks.onProgress?.({ ...this.progress });
  }

  private failCurrent(reason: string) {
    if (!this.current) return;
    this.hooks.log("warn", `File ${this.current.entry.fileIndex}: ${reason}`);
    if (!this.current.isDirectory) {
      this.stats.failed++;
      this.progress.filesDone++;
    }
    this.current = null;
  }

  private async processDownloadQueue() {
    if (!this.fetching || this.current) return;
    while (this.queue.length) {
      const entry = this.queue.shift()!;
      if (await this.hooks.isAlreadyDownloaded?.(entry)) {
        this.stats.skipped++;
        this.progress.filesDone++;
        this.progress.bytesDone += entry.fileSize;
        if (!this.opts.keepOnDevice) await this.send(`archivia ${entry.fileIndex}`, out.setFileFlags(entry.fileIndex, FileFlag.ARCHIVE));
        continue;
      }
      this.current = this.newDownload(entry, false);
      this.progress.fileIndex = entry.fileIndex;
      this.progress.fileName = fileTypeOf(entry.fileDataType, entry.fileSubType)?.name;
      this.hooks.onProgress?.({ ...this.progress });
      await this.send(`download ${entry.fileIndex}`, out.downloadRequest(entry.fileIndex));
      return;
    }
    // queue empty and nothing in flight: finish
    this.fetching = false;
    this.progress.phase = "processing";
    this.hooks.onProgress?.({ ...this.progress });
    try {
      await this.hooks.onSyncFinished?.({ ...this.stats });
    } finally {
      await this.send("sync complete", out.systemEvent(SystemEvent.SYNC_COMPLETE, 0));
      this.progress.phase = "done";
      this.hooks.onProgress?.({ ...this.progress });
      this.setState("ready");
      this.hooks.log("info", `Sincronizzazione terminata: ${this.stats.downloaded} scaricati, ${this.stats.skipped} già presenti, ${this.stats.failed} errori`);
    }
  }

  private checkStall() {
    if (!this.current || this.state === "disconnected") return;
    if (Date.now() - this.current.lastActivity > 30_000) {
      this.failCurrent("nessun dato da 30 s, salto il file");
      if (!this.processing) void this.drain().then(() => this.processDownloadQueue());
    }
  }
}
