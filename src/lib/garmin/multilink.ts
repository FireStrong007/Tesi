/**
 * Garmin "Multi-Link" (ML) layer on top of the BLE characteristics: services are
 * registered on handle 0 and then addressed by a 1-byte handle prefix.
 * GFDI runs on its own handle, framed with COBS.
 * Port of Gadgetbridge's CommunicatorV2 without the reliable (MLR) mode (AGPL-3.0).
 */
import { ByteReader, ByteWriter, hex } from "../bytes";
import { CobsStreamDecoder, cobsEncode } from "./cobs";
import type { BleTransport } from "./transport";

export enum MlService {
  GFDI = 1,
  REGISTRATION = 4,
  REALTIME_HR = 6,
  REALTIME_STEPS = 7,
  REALTIME_CALORIES = 8,
  REALTIME_FLOORS = 9,
  REALTIME_INTENSITY = 10,
  REALTIME_HRV = 12,
  REALTIME_STRESS = 13,
  REALTIME_SPO2 = 19,
  REALTIME_BODY_BATTERY = 20,
  REALTIME_RESPIRATION = 21,
}

/** Realtime channels whose payload format is known (from Gadgetbridge's CommunicatorV2 callbacks). */
export const LIVE_SERVICES = [
  MlService.REALTIME_HR,
  MlService.REALTIME_STEPS,
  MlService.REALTIME_BODY_BATTERY,
  MlService.REALTIME_RESPIRATION,
  MlService.REALTIME_FLOORS,
] as const;
/** Live SpO2 probably keeps the pulse-ox sensor on: opt-in only. */
export const LIVE_SPO2 = MlService.REALTIME_SPO2;

export interface RealtimeUpdate {
  heartRate?: number;
  restingHeartRate?: number;
  /** steps counted today by the band */
  steps?: number;
  stepGoal?: number;
  bodyBattery?: number;
  spo2?: number;
  respiration?: number;
  floorsUp?: number;
  floorsDown?: number;
}

enum RequestType {
  REGISTER_ML_REQ = 0,
  REGISTER_ML_RESP = 1,
  CLOSE_HANDLE_REQ = 2,
  CLOSE_HANDLE_RESP = 3,
  UNK_HANDLE = 4,
  CLOSE_ALL_REQ = 5,
  CLOSE_ALL_RESP = 6,
  UNK_REQ = 7,
  UNK_RESP = 8,
}

/** Gadgetbridge uses 2; any stable id works. */
const CLIENT_ID = 2n;

export interface MultiLinkEvents {
  onGfdiReady(): void;
  onGfdiMessage(message: Uint8Array): void;
  onRealtime?(update: RealtimeUpdate): void;
  log(msg: string): void;
}

export class MultiLink {
  private handleByService = new Map<MlService, number>();
  private serviceByHandle = new Map<number, MlService>();
  private cobs = new CobsStreamDecoder();
  private closingAll = false;
  /** services with a registration request in flight */
  private pending = new Set<MlService>();
  /** maximum bytes per GATT write, including the handle byte */
  maxWriteSize = 20;

  constructor(private transport: BleTransport, private events: MultiLinkEvents) {
    transport.onNotification((p) => this.onPacket(p));
  }

  get gfdiReady() {
    return this.handleByService.has(MlService.GFDI);
  }

  async start() {
    this.closingAll = true;
    await this.transport.write(this.mgmt(RequestType.CLOSE_ALL_REQ, (w) => w.u16(0)));
  }

  private mgmt(type: RequestType, body: (w: ByteWriter) => void): Uint8Array {
    const w = new ByteWriter(13);
    w.u8(0); // handle 0 = management
    w.u8(type);
    w.u64(CLIENT_ID);
    body(w);
    // Gadgetbridge always sends 13 bytes
    while (w.pos < 13) w.u8(0);
    return w.toBytes();
  }

  async registerService(service: MlService) {
    if (this.handleByService.has(service) || this.pending.has(service)) return;
    this.pending.add(service);
    setTimeout(() => this.pending.delete(service), 5000); // band never answered: allow a retry
    await this.transport.write(
      this.mgmt(RequestType.REGISTER_ML_REQ, (w) => {
        w.u16(service);
        w.u8(0); // reliable = false (plain ML)
      }),
    );
  }

  async closeService(service: MlService) {
    const handle = this.handleByService.get(service);
    if (handle === undefined) return;
    await this.transport.write(
      this.mgmt(RequestType.CLOSE_HANDLE_REQ, (w) => {
        w.u16(service);
        w.u8(handle);
      }),
    );
  }

  isRegistered(service: MlService) {
    return this.handleByService.has(service);
  }

  /** Sends a complete GFDI message (already with length + CRC). */
  async sendGfdi(message: Uint8Array) {
    const handle = this.handleByService.get(MlService.GFDI);
    if (handle === undefined) throw new Error("Canale GFDI non ancora aperto");
    const payload = cobsEncode(message);
    const chunk = Math.max(1, this.maxWriteSize - 1);
    for (let pos = 0; pos < payload.length; pos += chunk) {
      const frag = payload.subarray(pos, Math.min(payload.length, pos + chunk));
      const pkt = new Uint8Array(frag.length + 1);
      pkt[0] = handle;
      pkt.set(frag, 1);
      await this.transport.write(pkt);
    }
  }

  private onPacket(value: Uint8Array) {
    if (value.length === 0) return;
    const handle = value[0];
    if (handle === 0) {
      this.processManagement(new ByteReader(value.subarray(1)));
      return;
    }
    const service = this.serviceByHandle.get(handle);
    const payload = value.subarray(1);
    switch (service) {
      case MlService.GFDI:
        for (const msg of this.cobs.push(payload)) this.events.onGfdiMessage(msg);
        break;
      case MlService.REALTIME_HR:
        // [type, hr, resting, ff, ff]
        if (payload.length >= 3 && payload[1] > 0)
          this.events.onRealtime?.({ heartRate: payload[1], ...(payload[2] > 0 && payload[2] < 0xff ? { restingHeartRate: payload[2] } : {}) });
        break;
      case MlService.REALTIME_STEPS:
        // u32 steps today, u32 goal
        if (payload.length >= 8) {
          const r = new ByteReader(payload);
          this.events.onRealtime?.({ steps: r.u32(), stepGoal: r.u32() });
        }
        break;
      case MlService.REALTIME_BODY_BATTERY: {
        // signed byte, 0x7f = unknown
        const v = (payload[0] << 24) >> 24;
        if (payload.length >= 1 && payload[0] !== 0x7f && v >= 0 && v <= 100) this.events.onRealtime?.({ bodyBattery: v });
        break;
      }
      case MlService.REALTIME_SPO2: {
        // signed byte spo2 (-1 unknown) + u32 garmin timestamp
        const v = (payload[0] << 24) >> 24;
        if (payload.length >= 1 && v > 0 && v <= 100) this.events.onRealtime?.({ spo2: v });
        break;
      }
      case MlService.REALTIME_RESPIRATION: {
        // signed byte breaths/min, negative = unknown
        const v = (payload[0] << 24) >> 24;
        if (payload.length >= 1 && v > 0) this.events.onRealtime?.({ respiration: v });
        break;
      }
      case MlService.REALTIME_FLOORS:
        if (payload.length >= 6) {
          const r = new ByteReader(payload);
          this.events.onRealtime?.({ floorsUp: r.u16(), floorsDown: r.u16() });
        }
        break;
      default:
        this.events.log(`Pacchetto per handle sconosciuto ${handle}: ${hex(value, 64)}`);
    }
  }

  private processManagement(r: ByteReader) {
    const type = r.u8() as RequestType;
    const clientId = r.u64();
    if (clientId !== CLIENT_ID) {
      this.events.log(`Ignoro messaggio ML per client ${clientId}`);
      return;
    }
    switch (type) {
      case RequestType.REGISTER_ML_RESP: {
        const service = r.u16() as MlService;
        const status = r.u8();
        this.pending.delete(service);
        if (status !== 0) {
          // some bands do not offer every realtime channel: not an error
          this.events.log(`Servizio ${MlService[service] ?? service} non disponibile (status ${status})`);
          return;
        }
        const handle = r.u8();
        const reliable = r.remaining() > 0 ? r.u8() : 0;
        if (reliable) this.events.log(`Attenzione: il dispositivo ha attivato la modalità affidabile (MLR) su ${service}, non supportata`);
        this.handleByService.set(service, handle);
        this.serviceByHandle.set(handle, service);
        this.events.log(`Servizio ${MlService[service] ?? service} registrato su handle ${handle}`);
        if (service === MlService.GFDI) {
          this.cobs.reset();
          this.events.onGfdiReady();
        }
        break;
      }
      case RequestType.CLOSE_HANDLE_RESP: {
        const service = r.u16() as MlService;
        const handle = r.u8();
        this.handleByService.delete(service);
        this.serviceByHandle.delete(handle);
        if (service === MlService.GFDI && !this.closingAll) {
          this.events.log("Canale GFDI chiuso dal dispositivo, lo riapro");
          void this.registerService(MlService.GFDI);
        }
        break;
      }
      case RequestType.CLOSE_ALL_RESP:
        this.closingAll = false;
        this.pending.clear();
        this.handleByService.clear();
        this.serviceByHandle.clear();
        void this.registerService(MlService.GFDI);
        break;
      default:
        break;
    }
  }
}
