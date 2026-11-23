/**
 * GFDI (Garmin Flexible Device Interface) message framing and the message types
 * needed to pair, configure and download files from a Garmin watch/band.
 *
 * Wire format (little endian): u16 length (incl. CRC), u16 type, payload..., u16 crc
 * Ported from Gadgetbridge (AGPL-3.0), see service/devices/garmin/messages.
 */
import { ByteReader, ByteWriter } from "../bytes";
import { crc16 } from "./crc";
import { GARMIN_EPOCH } from "./time";

export const Msg = {
  RESPONSE: 5000,
  DOWNLOAD_REQUEST: 5002,
  UPLOAD_REQUEST: 5003,
  FILE_TRANSFER_DATA: 5004,
  CREATE_FILE: 5005,
  DELETE_FILE: 5006,
  FILTER: 5007,
  SET_FILE_FLAG: 5008,
  FILE_AVAILABLE: 5009,
  FIT_DEFINITION: 5011,
  FIT_DATA: 5012,
  WEATHER_REQUEST: 5014,
  BATTERY_STATUS: 5023,
  DEVICE_INFORMATION: 5024,
  DEVICE_SETTINGS: 5026,
  SYSTEM_EVENT: 5030,
  SUPPORTED_FILE_TYPES_REQUEST: 5031,
  NOTIFICATION_UPDATE: 5033,
  NOTIFICATION_CONTROL: 5034,
  NOTIFICATION_DATA: 5035,
  NOTIFICATION_SUBSCRIPTION: 5036,
  SYNCHRONIZATION: 5037,
  FIND_MY_PHONE_REQUEST: 5039,
  FIND_MY_PHONE_CANCEL: 5040,
  MUSIC_CONTROL: 5041,
  MUSIC_CONTROL_CAPABILITIES: 5042,
  PROTOBUF_REQUEST: 5043,
  PROTOBUF_RESPONSE: 5044,
  MUSIC_CONTROL_ENTITY_UPDATE: 5049,
  CONFIGURATION: 5050,
  CURRENT_TIME_REQUEST: 5052,
  AUTH_NEGOTIATION: 5101,
} as const;

export const MsgName: Record<number, string> = Object.fromEntries(
  Object.entries(Msg).map(([k, v]) => [v, k]),
);

export enum Status {
  ACK = 0,
  NAK = 1,
  UNSUPPORTED = 2,
  DECODE_ERROR = 3,
  CRC_ERROR = 4,
  LENGTH_ERROR = 5,
}

export enum SystemEvent {
  SYNC_COMPLETE = 0,
  SYNC_FAIL = 1,
  FACTORY_RESET = 2,
  PAIR_START = 3,
  PAIR_COMPLETE = 4,
  PAIR_FAIL = 5,
  HOST_DID_ENTER_FOREGROUND = 6,
  HOST_DID_ENTER_BACKGROUND = 7,
  SYNC_READY = 8,
  NEW_DOWNLOAD_AVAILABLE = 9,
  DEVICE_SOFTWARE_UPDATE = 10,
  DEVICE_DISCONNECT = 11,
  TUTORIAL_COMPLETE = 12,
  SETUP_WIZARD_START = 13,
  SETUP_WIZARD_COMPLETE = 14,
  SETUP_WIZARD_SKIPPED = 15,
  TIME_UPDATED = 16,
  TRIGGER_REBOOT = 17,
}

export enum FilterType {
  ALL_FILES = 0,
  DEFAULT = 1,
  UNK_2 = 2,
  ONLY_NEW = 3,
}

export enum DownloadStatus {
  OK = 0,
  INDEX_NOT_FOUND = 1,
  NOT_READABLE = 2,
  NOT_READY = 3,
  INVALID_REQUEST = 4,
  CRC_MISMATCH = 5,
  RANGE_EXCEEDS_FILE = 6,
}

export enum TransferStatus {
  OK = 0,
  RESEND = 1,
  ABORT = 2,
  CRC_MISMATCH = 3,
  OFFSET_MISMATCH = 4,
  SYNC_PAUSED = 5,
}

export const FileFlag = {
  ARCHIVE: 0x10,
} as const;

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

export function buildMessage(type: number, body?: (w: ByteWriter) => void): Uint8Array {
  const w = new ByteWriter(64);
  w.u16(0); // length placeholder
  w.u16(type);
  body?.(w);
  const lengthWithCrc = w.pos + 2;
  w.setU16At(0, lengthWithCrc);
  const sofar = w.toBytes();
  w.u16(crc16(sofar));
  return w.toBytes();
}

export interface RawMessage {
  type: number;
  /** reader positioned at the start of the payload, limited before the CRC */
  reader: ByteReader;
  bytes: Uint8Array;
}

export class GfdiParseError extends Error {}

export function parseMessage(bytes: Uint8Array): RawMessage {
  if (bytes.length < 6) throw new GfdiParseError("Messaggio GFDI troppo corto");
  const r = new ByteReader(bytes);
  const length = r.u16();
  if (length !== bytes.length) throw new GfdiParseError(`Lunghezza GFDI non valida (${length} != ${bytes.length})`);
  const crcGiven = bytes[length - 2] | (bytes[length - 1] << 8);
  const crcCalc = crc16(bytes, 0, 0, length - 2);
  if (crcGiven !== crcCalc) throw new GfdiParseError("CRC GFDI non valido");
  r.limit = length - 2;
  let type = r.u16();
  if (type & 0x8000) type = (type & 0xff) + 5000; // compact form
  return { type, reader: r, bytes };
}

// ---------------------------------------------------------------------------
// Outgoing builders
// ---------------------------------------------------------------------------

export const out = {
  status(originalType: number, status: Status = Status.ACK) {
    return buildMessage(Msg.RESPONSE, (w) => {
      w.u16(originalType);
      w.u8(status);
    });
  },

  deviceInformationResponse(incomingProtocolVersion: number, host: { name: string; manufacturer: string; model: string }) {
    const protocolFlags = Math.floor(incomingProtocolVersion / 100) === 1 ? 1 : 0;
    return buildMessage(Msg.RESPONSE, (w) => {
      w.u16(Msg.DEVICE_INFORMATION);
      w.u8(Status.ACK);
      w.u16(150); // our protocol version
      w.u16(0xffff); // our product number (-1)
      w.u32(0xffffffff); // our unit number (-1)
      w.u16(7791); // our software version
      w.u16(0xffff); // our max packet size (-1)
      w.string(host.name);
      w.string(host.manufacturer);
      w.string(host.model);
      w.u8(protocolFlags);
    });
  },

  configuration(capabilities: Uint8Array) {
    return buildMessage(Msg.CONFIGURATION, (w) => {
      w.u8(capabilities.length);
      w.bytes(capabilities);
    });
  },

  currentTimeResponse(referenceId: number, now = new Date()) {
    const unix = Math.floor(now.getTime() / 1000);
    const tzOffset = -now.getTimezoneOffset() * 60;
    const { nextStart, nextEnd } = nextDstTransitions(now);
    return buildMessage(Msg.RESPONSE, (w) => {
      w.u16(Msg.CURRENT_TIME_REQUEST);
      w.u8(Status.ACK);
      w.u32(referenceId);
      w.u32(unix - GARMIN_EPOCH);
      w.i32(tzOffset);
      w.u32(nextEnd ? nextEnd - GARMIN_EPOCH : 0);
      w.u32(nextStart ? nextStart - GARMIN_EPOCH : 0);
    });
  },

  systemEvent(event: SystemEvent, value: number | string = 0) {
    return buildMessage(Msg.SYSTEM_EVENT, (w) => {
      w.u8(event);
      if (typeof value === "string") w.string(value);
      else w.u8(value);
    });
  },

  supportedFileTypesRequest() {
    return buildMessage(Msg.SUPPORTED_FILE_TYPES_REQUEST);
  },

  deviceSettings(settings: { autoUpload: boolean; weatherConditions: boolean; weatherAlerts: boolean }) {
    // GarminDeviceSetting ordinals: AUTO_UPLOAD_ENABLED=6, WEATHER_CONDITIONS_ENABLED=7, WEATHER_ALERTS_ENABLED=8
    const entries: [number, boolean][] = [
      [6, settings.autoUpload],
      [7, settings.weatherConditions],
      [8, settings.weatherAlerts],
    ];
    return buildMessage(Msg.DEVICE_SETTINGS, (w) => {
      w.u8(entries.length);
      for (const [id, v] of entries) {
        w.u8(id);
        w.u8(1);
        w.u8(v ? 1 : 0);
      }
    });
  },

  downloadRequest(fileIndex: number, dataOffset = 0, newRequest = true, crcSeed = 0, dataSize = 0) {
    return buildMessage(Msg.DOWNLOAD_REQUEST, (w) => {
      w.u16(fileIndex);
      w.u32(dataOffset);
      w.u8(newRequest ? 1 : 0); // REQUEST_TYPE: CONTINUE=0, NEW=1
      w.u16(crcSeed);
      w.u32(dataSize);
      w.u8(0); // flags
    });
  },

  fileTransferDataAck(dataOffset: number, status: TransferStatus = TransferStatus.OK) {
    return buildMessage(Msg.RESPONSE, (w) => {
      w.u16(Msg.FILE_TRANSFER_DATA);
      w.u8(Status.ACK);
      w.u8(status);
      w.u32(dataOffset);
    });
  },

  setFileFlags(fileIndex: number, flags: number) {
    return buildMessage(Msg.SET_FILE_FLAG, (w) => {
      w.u16(fileIndex);
      w.u8(flags);
    });
  },

  filter(type: FilterType) {
    return buildMessage(Msg.FILTER, (w) => w.u8(type));
  },

  protobufRequest(requestId: number, payload: Uint8Array) {
    return buildMessage(Msg.PROTOBUF_REQUEST, (w) => {
      w.u16(requestId);
      w.u32(0); // offset
      w.u32(payload.length); // total length
      w.u32(payload.length); // chunk length
      w.bytes(payload);
    });
  },

  protobufStatus(originalType: number, requestId: number, dataOffset: number, chunkStatus = 0, statusCode = 0) {
    return buildMessage(Msg.RESPONSE, (w) => {
      w.u16(originalType);
      w.u8(Status.ACK);
      w.u16(requestId);
      w.u32(dataOffset);
      w.u8(chunkStatus); // KEPT
      w.u8(statusCode); // NO_ERROR
    });
  },

  authNegotiationStatus(unknown: number, flags: number) {
    return buildMessage(Msg.RESPONSE, (w) => {
      w.u16(Msg.AUTH_NEGOTIATION);
      w.u8(Status.ACK);
      w.u8(0); // GUESS_OK
      w.u8(unknown);
      w.u32(flags);
    });
  },

  notificationSubscriptionStatus(enable: boolean, unk: number) {
    return buildMessage(Msg.RESPONSE, (w) => {
      w.u16(Msg.NOTIFICATION_SUBSCRIPTION);
      w.u8(Status.ACK);
      w.u8(1); // NotificationStatus.DISABLED: a web app cannot forward phone notifications
      w.u8(enable ? 1 : 0);
      w.u8(unk);
    });
  },
};

/** Finds the next two DST transitions (unix seconds) for the local time zone, by probing hourly offsets. */
export function nextDstTransitions(now: Date): { nextStart: number | null; nextEnd: number | null } {
  const found: number[] = [];
  let prevOffset = now.getTimezoneOffset();
  const startMs = now.getTime();
  const hour = 3600_000;
  for (let t = startMs + hour; t < startMs + 400 * 24 * hour && found.length < 2; t += hour) {
    const off = new Date(t).getTimezoneOffset();
    if (off !== prevOffset) {
      // refine to the minute
      let lo = t - hour;
      let hi = t;
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 2);
        if (new Date(mid).getTimezoneOffset() === prevOffset) lo = mid;
        else hi = mid;
      }
      found.push(Math.floor(hi / 1000 / 60) * 60);
      prevOffset = off;
    }
  }
  return { nextStart: found[0] ?? null, nextEnd: found[1] ?? null };
}

// ---------------------------------------------------------------------------
// Incoming parsers
// ---------------------------------------------------------------------------

export interface DeviceInformation {
  protocolVersion: number;
  productNumber: number;
  unitNumber: string;
  softwareVersion: number;
  softwareVersionStr: string;
  maxPacketSize: number;
  bluetoothFriendlyName: string;
  deviceName: string;
  deviceModel: string;
}

export function parseDeviceInformation(r: ByteReader): DeviceInformation {
  const protocolVersion = r.u16();
  const productNumber = r.u16();
  const unitNumber = String(r.u32());
  const softwareVersion = r.u16();
  const maxPacketSize = r.u16();
  const bluetoothFriendlyName = r.string();
  const deviceName = r.string();
  const deviceModel = r.string();
  return {
    protocolVersion,
    productNumber,
    unitNumber,
    softwareVersion,
    softwareVersionStr: `${Math.floor(softwareVersion / 100)}.${String(softwareVersion % 100).padStart(2, "0")}`,
    maxPacketSize,
    bluetoothFriendlyName,
    deviceName,
    deviceModel,
  };
}

export function parseConfiguration(r: ByteReader): Uint8Array {
  const n = r.u8();
  return r.bytesN(n);
}

export interface DirectoryEntry {
  fileIndex: number;
  fileDataType: number;
  fileSubType: number;
  fileNumber: number;
  specificFlags: number;
  fileFlags: number;
  fileSize: number;
  /** unix seconds or null */
  fileDate: number | null;
}

export function parseDirectoryEntry(r: ByteReader): DirectoryEntry {
  const fileIndex = r.u16();
  const fileDataType = r.u8();
  const fileSubType = r.u8();
  const fileNumber = r.u16();
  const specificFlags = r.u8();
  const fileFlags = r.u8();
  const fileSize = r.u32();
  const ts = r.u32();
  return {
    fileIndex,
    fileDataType,
    fileSubType,
    fileNumber,
    specificFlags,
    fileFlags,
    fileSize,
    fileDate: ts === 0 ? null : ts + GARMIN_EPOCH,
  };
}

export function parseDirectory(data: Uint8Array): DirectoryEntry[] {
  if (data.length % 16 !== 0) throw new GfdiParseError("Lunghezza directory non valida");
  const r = new ByteReader(data);
  const entries: DirectoryEntry[] = [];
  while (r.remaining() > 0) entries.push(parseDirectoryEntry(r));
  return entries;
}

export interface StatusResponse {
  originalType: number;
  status: Status;
  reader: ByteReader;
}

export function parseStatus(r: ByteReader): StatusResponse {
  const originalType = r.u16();
  const status = r.u8() as Status;
  return { originalType, status, reader: r };
}

export interface FileTransferData {
  flags: number;
  crc: number;
  dataOffset: number;
  data: Uint8Array;
}

export function parseFileTransferData(r: ByteReader): FileTransferData {
  const flags = r.u8();
  const crc = r.u16();
  const dataOffset = r.u32();
  const data = r.bytesN(r.remaining());
  return { flags, crc, dataOffset, data };
}

export interface ProtobufChunk {
  requestId: number;
  dataOffset: number;
  totalLength: number;
  chunkLength: number;
  data: Uint8Array;
}

export function parseProtobuf(r: ByteReader): ProtobufChunk {
  const requestId = r.u16();
  const dataOffset = r.u32();
  const totalLength = r.u32();
  const chunkLength = r.u32();
  const data = r.bytesN(chunkLength);
  return { requestId, dataOffset, totalLength, chunkLength, data };
}

export interface SupportedFileType {
  dataType: number;
  subType: number;
  name: string;
}

export function parseSupportedFileTypes(r: ByteReader): SupportedFileType[] {
  const n = r.u8();
  const list: SupportedFileType[] = [];
  for (let i = 0; i < n; i++) list.push({ dataType: r.u8(), subType: r.u8(), name: r.string() });
  return list;
}

export interface SynchronizationRequest {
  type: number; // 0 manual, 1 automatic
  bitmask: bigint;
}

export function parseSynchronization(r: ByteReader): SynchronizationRequest | null {
  const type = r.u8();
  const size = r.u8();
  let bitmask: bigint;
  if (size === 8) bitmask = r.u64();
  else if (size === 4) bitmask = BigInt(r.u32());
  else return null;
  return { type, bitmask };
}

/** SynchronizationMessage.shouldProceed: WORKOUTS(3) | ACTIVITIES(5) | ACTIVITY_SUMMARY(21) | SLEEP(26) | manual */
export function syncShouldProceed(s: SynchronizationRequest): boolean {
  const bits = [3n, 5n, 21n, 26n];
  return s.type === 0 || bits.some((b) => (s.bitmask & (1n << b)) !== 0n);
}

export interface BatteryStatus {
  status: string;
  voltage: number;
  percent: number;
}

export function parseBatteryStatus(r: ByteReader): BatteryStatus {
  const wire = r.u8();
  const voltage = r.u8() / 100;
  const percent = r.u8();
  const map: Record<number, string> = { 0x10: "good", 0x20: "ok", 0x30: "low", 0x40: "critical", 0x50: "new", 0x70: "invalid" };
  return { status: map[wire & 0x70] ?? "unknown", voltage, percent };
}
