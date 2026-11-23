/**
 * In-memory simulation of a Garmin vívosmart 5 speaking Multi-Link + GFDI.
 * Used by the test-suite and by the app's demo mode: the demo goes through the
 * very same session, file transfer, FIT decoding and import code as a real band.
 */
import { ByteReader, ByteWriter, concatBytes } from "../bytes";
import { CobsStreamDecoder, cobsEncode } from "../garmin/cobs";
import { crc16 } from "../garmin/crc";
import { Msg, buildMessage, parseMessage } from "../garmin/gfdi";
import { pbDecode, pbEncode, pbGetMessage } from "../garmin/protobuf";
import { unixToGarmin } from "../garmin/time";
import type { BleTransport } from "../garmin/transport";

export interface FakeFile {
  dataType: number;
  subType: number;
  fileNumber: number;
  date: number; // unix
  data: Uint8Array;
}

export interface FakeWatchOptions {
  files: FakeFile[];
  battery?: number;
  /** simulated BLE latency per packet in ms (0 = microtask) */
  latencyMs?: number;
  /** max bytes per notification */
  mtu?: number;
  /** called when the host lists the directory: returns files the band has written since (simulates time passing) */
  newFiles?: () => FakeFile[];
  log?: (m: string) => void;
}

export class FakeWatch implements BleTransport {
  readonly id = "demo-vivosmart5";
  readonly name = "vívosmart 5 (demo)";
  private notify: (p: Uint8Array) => void = () => {};
  private disconnectHandlers: (() => void)[] = [];
  private gfdiHandle = 0;
  private cobs = new CobsStreamDecoder();
  private files: (FakeFile & { index: number; archived: boolean })[];
  private transfer: { data: Uint8Array; offset: number; crc: number } | null = null;
  private connected = true;
  /** everything the host sent, decoded, for assertions in tests */
  readonly received: { type: number; bytes: Uint8Array }[] = [];
  /** every service registration request received (for tests) */
  readonly registrations: number[] = [];
  battery: number;
  findActive = false;

  constructor(private opts: FakeWatchOptions) {
    this.files = opts.files.map((f, i) => ({ ...f, index: i + 1, archived: false }));
    this.battery = opts.battery ?? 78;
  }

  /** adds files to the band's storage (they will be listed at the next directory request) */
  addFiles(files: FakeFile[]) {
    let next = this.files.reduce((m, f) => Math.max(m, f.index), 0) + 1;
    for (const f of files) this.files.push({ ...f, index: next++, archived: false });
  }

  get archivedCount() {
    return this.files.filter((f) => f.archived).length;
  }

  onNotification(h: (p: Uint8Array) => void) {
    this.notify = h;
  }
  onDisconnect(h: () => void) {
    this.disconnectHandlers.push(h);
  }
  async disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.disconnectHandlers.forEach((h) => h());
  }

  private emit(packet: Uint8Array) {
    if (!this.connected) return;
    const delay = this.opts.latencyMs ?? 0;
    if (delay > 0) setTimeout(() => this.connected && this.notify(packet), delay);
    else queueMicrotask(() => this.connected && this.notify(packet));
  }

  private sendGfdi(msg: Uint8Array) {
    const enc = cobsEncode(msg);
    const chunk = (this.opts.mtu ?? 244) - 1;
    for (let i = 0; i < enc.length; i += chunk) {
      this.emit(concatBytes(Uint8Array.of(this.gfdiHandle), enc.subarray(i, i + chunk)));
    }
  }

  private mgmtResponse(type: number, body: (w: ByteWriter) => void) {
    const w = new ByteWriter(16);
    w.u8(0);
    w.u8(type);
    w.u64(2n);
    body(w);
    this.emit(w.toBytes());
  }

  async write(packet: Uint8Array): Promise<void> {
    if (!this.connected) throw new Error("disconnected");
    if (packet[0] === 0) {
      const r = new ByteReader(packet.subarray(1));
      const type = r.u8();
      r.u64();
      if (type === 5) {
        // CLOSE_ALL_REQ
        this.mgmtResponse(6, () => {});
      } else if (type === 0) {
        // REGISTER_ML_REQ
        const service = r.u16();
        this.registrations.push(service);
        const handle = service === 1 ? 1 : 0x20 + service; // unique per service
        if (service === 1) this.gfdiHandle = handle;
        if (service !== 1) this.liveHandles.set(service, handle);
        this.mgmtResponse(1, (w) => {
          w.u16(service);
          w.u8(0);
          w.u8(handle);
          w.u8(0);
        });
        if (service === 1) setTimeout(() => this.sendDeviceInformation(), 5);
        if (service !== 1) this.startLive(service);
      } else if (type === 2) {
        const service = r.u16();
        const handle = r.u8();
        this.liveHandles.delete(service);
        this.mgmtResponse(3, (w) => {
          w.u16(service);
          w.u8(handle);
          w.u8(0);
        });
      }
      return;
    }
    if (packet[0] === this.gfdiHandle) {
      for (const m of this.cobs.push(packet.subarray(1))) this.onHostMessage(m);
    }
  }

  /** live channels: service id -> handle, with one emitter timer each */
  private liveHandles = new Map<number, number>();
  private liveTimers = new Map<number, ReturnType<typeof setInterval>>();
  /** simulated "today" counters for the live channels */
  liveSteps = 4200 + Math.round(Math.random() * 1500);
  private liveHr = 66;
  private liveEnergy = 62;

  /** ms between packets of each live channel (the real band sends roughly 1/s for HR and steps) */
  liveIntervals: Record<number, number> = { 6: 1000, 7: 2000, 9: 10000, 19: 5000, 20: 10000, 21: 5000 };

  private startLive(service: number) {
    if (this.liveTimers.has(service) || !this.liveIntervals[service]) return;
    const tick = () => {
      const handle = this.liveHandles.get(service);
      if (!handle || !this.connected) {
        clearInterval(this.liveTimers.get(service));
        this.liveTimers.delete(service);
        return;
      }
      const w = new ByteWriter(8);
      w.u8(handle);
      switch (service) {
        case 6: // [type, hr, resting, ff, ff]
          this.liveHr = Math.max(55, Math.min(125, this.liveHr + (Math.random() - 0.48) * 4));
          w.u8(3).u8(Math.round(this.liveHr)).u8(58).u8(0xff).u8(0xff);
          break;
        case 7: // u32 steps today, u32 goal
          if (Math.random() < 0.6) this.liveSteps += Math.round(Math.random() * 6);
          w.u32(this.liveSteps).u32(8000);
          break;
        case 9: // floors up, down, target
          w.u16(4).u16(3).u16(10);
          break;
        case 19: // spo2 + garmin timestamp
          w.i8(95 + Math.round(Math.random() * 3)).u32(unixToGarmin(Math.floor(Date.now() / 1000)));
          break;
        case 20: // body battery
          if (Math.random() < 0.2) this.liveEnergy = Math.max(5, this.liveEnergy - 1);
          w.i8(this.liveEnergy);
          break;
        case 21: // respiration
          w.i8(14 + Math.round(Math.random() * 3));
          break;
      }
      this.emit(w.toBytes());
    };
    this.liveTimers.set(service, setInterval(tick, this.liveIntervals[service]));
    setTimeout(tick, 50);
  }

  private sendDeviceInformation() {
    this.sendGfdi(
      buildMessage(Msg.DEVICE_INFORMATION, (w) => {
        w.u16(150); // protocol
        w.u16(3466); // product number (vívosmart 5 is 3466 in Garmin's list... demo value)
        w.u32(3412345678);
        w.u16(1408); // sw 14.08
        w.u16(375); // max packet
        w.string("vívosmart 5");
        w.string("vívosmart 5");
        w.string("vívosmart 5");
      }),
    );
  }

  private onHostMessage(bytes: Uint8Array) {
    const msg = parseMessage(bytes);
    this.received.push({ type: msg.type, bytes });
    const r = msg.reader;
    switch (msg.type) {
      case Msg.RESPONSE: {
        const orig = r.u16();
        if (orig === Msg.DEVICE_INFORMATION && r.remaining() > 1) {
          // full device information response -> continue with configuration
          setTimeout(() => this.sendGfdi(buildMessage(Msg.CONFIGURATION, (w) => {
            const caps = new Uint8Array(15).fill(0xff);
            w.u8(caps.length);
            w.bytes(caps);
          })), 5);
        } else if (orig === Msg.FILE_TRANSFER_DATA) {
          r.u8();
          r.u8();
          const offset = r.u32();
          if (this.transfer && offset === this.transfer.offset && offset < this.transfer.data.length) this.sendChunk();
        }
        return;
      }
      case Msg.SUPPORTED_FILE_TYPES_REQUEST:
        this.sendGfdi(buildMessage(Msg.RESPONSE, (w) => {
          w.u16(Msg.SUPPORTED_FILE_TYPES_REQUEST);
          w.u8(0);
          const types: [number, number, string][] = [[128, 4, "FIT_TYPE_4"], [128, 32, "FIT_TYPE_32"], [128, 49, "FIT_TYPE_49"], [128, 68, "FIT_TYPE_68"], [128, 44, "FIT_TYPE_44"]];
          w.u8(types.length);
          for (const [a, b, n] of types) {
            w.u8(a);
            w.u8(b);
            w.string(n);
          }
        }));
        return;
      case Msg.DOWNLOAD_REQUEST: {
        const index = r.u16();
        if (index === 0) this.addFiles(this.opts.newFiles?.() ?? []);
        const data = index === 0 ? this.directory() : this.files.find((f) => f.index === index && !f.archived)?.data;
        if (!data) {
          this.sendGfdi(this.downloadStatus(1, 0));
          return;
        }
        this.transfer = { data, offset: 0, crc: 0 };
        this.sendGfdi(this.downloadStatus(0, data.length));
        setTimeout(() => this.sendChunk(), 2);
        return;
      }
      case Msg.SET_FILE_FLAG: {
        const index = r.u16();
        const flags = r.u8();
        const f = this.files.find((x) => x.index === index);
        if (f && flags & 0x10) f.archived = true;
        this.ack(Msg.SET_FILE_FLAG);
        return;
      }
      case Msg.PROTOBUF_REQUEST: {
        const requestId = r.u16();
        r.u32();
        r.u32();
        const len = r.u32();
        const pb = r.bytesN(len);
        this.ack(Msg.PROTOBUF_REQUEST);
        const root = pbDecode(pb);
        if (pbGetMessage(pbGetMessage(root, 8), 2) !== undefined || root.get(8)) {
          const resp = pbEncode([[8, [[3, [[1, 1], [2, this.battery], [3, 1], [4, 96]]]]]]);
          this.sendGfdi(buildMessage(Msg.PROTOBUF_RESPONSE, (w) => {
            w.u16(requestId);
            w.u32(0);
            w.u32(resp.length);
            w.u32(resp.length);
            w.bytes(resp);
          }));
        }
        if (root.get(12)) this.findActive = !!pbGetMessage(pbGetMessage(root, 12), 1);
        return;
      }
      case Msg.SYSTEM_EVENT:
      case Msg.DEVICE_SETTINGS:
      case Msg.CONFIGURATION:
      case Msg.FILTER:
        this.ack(msg.type);
        return;
      default:
        return;
    }
  }

  private ack(type: number) {
    this.sendGfdi(buildMessage(Msg.RESPONSE, (w) => {
      w.u16(type);
      w.u8(0);
    }));
  }

  private downloadStatus(status: number, size: number) {
    return buildMessage(Msg.RESPONSE, (w) => {
      w.u16(Msg.DOWNLOAD_REQUEST);
      w.u8(0);
      w.u8(status);
      w.u32(size);
    });
  }

  private sendChunk() {
    const t = this.transfer;
    if (!t) return;
    const chunk = t.data.subarray(t.offset, Math.min(t.data.length, t.offset + 360));
    t.crc = crc16(chunk, t.crc);
    const offset = t.offset;
    t.offset += chunk.length;
    this.sendGfdi(buildMessage(Msg.FILE_TRANSFER_DATA, (w) => {
      w.u8(0);
      w.u16(t.crc);
      w.u32(offset);
      w.bytes(chunk);
    }));
    if (t.offset >= t.data.length) this.transfer = null;
  }

  private directory(): Uint8Array {
    const w = new ByteWriter(16 * (this.files.length + 1));
    for (const f of this.files) {
      if (f.archived) continue;
      w.u16(f.index);
      w.u8(f.dataType);
      w.u8(f.subType);
      w.u16(f.fileNumber);
      w.u8(0);
      w.u8(0);
      w.u32(f.data.length);
      w.u32(unixToGarmin(f.date));
    }
    return w.toBytes();
  }

  /** Simulates the band asking for a sync (e.g. new data available) */
  requestSync() {
    this.sendGfdi(buildMessage(Msg.SYNCHRONIZATION, (w) => {
      w.u8(1);
      w.u8(8);
      w.u64(1n << 26n);
    }));
  }
}
