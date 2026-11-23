/**
 * FIT file decoder (Flexible and Interoperable Data Transfer).
 * Handles normal and compressed-timestamp headers, developer fields (skipped),
 * arrays, strings, invalid values, scale/offset from the profile, chained files.
 */
import { crc16 } from "../garmin/crc";
import { GARMIN_EPOCH } from "../garmin/time";
import { FIT_PROFILE } from "./profile";

export const BaseType = {
  ENUM: 0x00,
  SINT8: 0x01,
  UINT8: 0x02,
  SINT16: 0x83,
  UINT16: 0x84,
  SINT32: 0x85,
  UINT32: 0x86,
  STRING: 0x07,
  FLOAT32: 0x88,
  FLOAT64: 0x89,
  UINT8Z: 0x0a,
  UINT16Z: 0x8b,
  UINT32Z: 0x8c,
  BYTE: 0x0d,
  SINT64: 0x8e,
  UINT64: 0x8f,
  UINT64Z: 0x90,
} as const;

const BASE_SIZE: Record<number, number> = {
  0x00: 1, 0x01: 1, 0x02: 1, 0x83: 2, 0x84: 2, 0x85: 4, 0x86: 4, 0x07: 1, 0x88: 4, 0x89: 8,
  0x0a: 1, 0x8b: 2, 0x8c: 4, 0x0d: 1, 0x8e: 8, 0x8f: 8, 0x90: 8,
};

export type FitValue = number | string | null | (number | null)[] | bigint;

export interface FitRecord {
  /** global message number */
  num: number;
  /** profile name, or "unknown_<num>" */
  name: string;
  /** decoded fields by profile name (or "field_<num>") with scale/offset applied */
  fields: Record<string, FitValue>;
  /** raw values by field number (no scaling) */
  raw: Record<number, FitValue>;
  /** unix seconds: timestamp field (253) or derived from a compressed header */
  timestamp: number | null;
}

export interface FitFile {
  protocolVersion: number;
  profileVersion: number;
  records: FitRecord[];
  crcOk: boolean;
  /** set when the file was only partially readable: records holds what was decoded before the problem */
  error?: string;
}

interface FieldDef {
  num: number;
  size: number;
  base: number;
}

interface Definition {
  globalNum: number;
  littleEndian: boolean;
  fields: FieldDef[];
  devBytes: number;
}

export class FitParseError extends Error {}

const textDecoder = new TextDecoder("utf-8");

function readValue(view: DataView, pos: number, base: number, le: boolean): number | bigint | null {
  switch (base) {
    case 0x00:
    case 0x02:
    case 0x0d: {
      const v = view.getUint8(pos);
      return v === 0xff ? null : v;
    }
    case 0x0a: {
      const v = view.getUint8(pos);
      return v === 0 ? null : v;
    }
    case 0x01: {
      const v = view.getInt8(pos);
      return v === 0x7f ? null : v;
    }
    case 0x83: {
      const v = view.getInt16(pos, le);
      return v === 0x7fff ? null : v;
    }
    case 0x84: {
      const v = view.getUint16(pos, le);
      return v === 0xffff ? null : v;
    }
    case 0x8b: {
      const v = view.getUint16(pos, le);
      return v === 0 ? null : v;
    }
    case 0x85: {
      const v = view.getInt32(pos, le);
      return v === 0x7fffffff ? null : v;
    }
    case 0x86: {
      const v = view.getUint32(pos, le);
      return v === 0xffffffff ? null : v;
    }
    case 0x8c: {
      const v = view.getUint32(pos, le);
      return v === 0 ? null : v;
    }
    case 0x88: {
      const raw = view.getUint32(pos, le);
      return raw === 0xffffffff ? null : view.getFloat32(pos, le);
    }
    case 0x89: {
      const v = view.getFloat64(pos, le);
      return Number.isNaN(v) ? null : v;
    }
    case 0x8e: {
      const v = view.getBigInt64(pos, le);
      return v === 0x7fffffffffffffffn ? null : v;
    }
    case 0x8f: {
      const v = view.getBigUint64(pos, le);
      return v === 0xffffffffffffffffn ? null : v;
    }
    case 0x90: {
      const v = view.getBigUint64(pos, le);
      return v === 0n ? null : v;
    }
    default:
      return view.getUint8(pos);
  }
}

export function decodeFit(bytes: Uint8Array): FitFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: FitRecord[] = [];
  let offset = 0;
  let protocolVersion = 0;
  let profileVersion = 0;
  let crcOk = true;
  let error: string | undefined;

  while (offset + 12 <= bytes.length) {
    const headerSize = view.getUint8(offset);
    if (headerSize !== 12 && headerSize !== 14) throw new FitParseError(`Header FIT non valido (${headerSize})`);
    protocolVersion = view.getUint8(offset + 1);
    profileVersion = view.getUint16(offset + 2, true);
    const dataSize = view.getUint32(offset + 4, true);
    const sig = String.fromCharCode(...bytes.subarray(offset + 8, offset + 12));
    if (sig !== ".FIT") throw new FitParseError("Firma .FIT mancante");
    const dataStart = offset + headerSize;
    const dataEnd = Math.min(dataStart + dataSize, bytes.length);
    if (dataEnd + 2 <= bytes.length) {
      const fileCrc = view.getUint16(dataEnd, true);
      const calc = crc16(bytes, 0, offset, dataEnd - offset);
      if (fileCrc !== 0 && fileCrc !== calc) crcOk = false;
    }
    try {
      parseRecords(bytes, view, dataStart, dataEnd, records);
    } catch (e) {
      // keep what was decoded so far (like Gadgetbridge, a damaged tail should not lose the whole file)
      error = (e as Error).message;
      if (!records.length) throw e;
      break;
    }
    offset = dataEnd + 2;
  }
  return { protocolVersion, profileVersion, records, crcOk, error };
}

function parseRecords(bytes: Uint8Array, view: DataView, start: number, end: number, records: FitRecord[]) {
  const defs = new Map<number, Definition>();
  let pos = start;
  let lastTimestamp = 0; // garmin seconds

  while (pos < end) {
    const header = view.getUint8(pos++);
    let localType: number;
    let compressedTs: number | null = null;

    if (header & 0x80) {
      // compressed timestamp header
      localType = (header >> 5) & 0x03;
      const offsetTs = header & 0x1f;
      let ts = (lastTimestamp & ~0x1f) + offsetTs;
      if (offsetTs < (lastTimestamp & 0x1f)) ts += 0x20;
      lastTimestamp = ts;
      compressedTs = ts;
    } else if (header & 0x40) {
      // definition message
      localType = header & 0x0f;
      const hasDev = (header & 0x20) !== 0;
      pos++; // reserved
      const arch = view.getUint8(pos++);
      const le = arch === 0;
      const globalNum = view.getUint16(pos, le);
      pos += 2;
      const nFields = view.getUint8(pos++);
      const fields: FieldDef[] = [];
      for (let i = 0; i < nFields; i++) {
        fields.push({ num: view.getUint8(pos), size: view.getUint8(pos + 1), base: view.getUint8(pos + 2) });
        pos += 3;
      }
      let devBytes = 0;
      if (hasDev) {
        const nDev = view.getUint8(pos++);
        for (let i = 0; i < nDev; i++) {
          devBytes += view.getUint8(pos + 1);
          pos += 3;
        }
      }
      defs.set(localType, { globalNum, littleEndian: le, fields, devBytes });
      continue;
    } else {
      localType = header & 0x0f;
    }

    const def = defs.get(localType);
    if (!def) throw new FitParseError(`Messaggio dati senza definizione (tipo locale ${localType}) a offset ${pos - 1}`);

    const profile = FIT_PROFILE[def.globalNum];
    const rec: FitRecord = {
      num: def.globalNum,
      name: profile?.name ?? `unknown_${def.globalNum}`,
      fields: {},
      raw: {},
      timestamp: null,
    };

    for (const f of def.fields) {
      const baseSize = BASE_SIZE[f.base] ?? 1;
      let value: FitValue;
      if (f.base === BaseType.STRING) {
        const slice = bytes.subarray(pos, pos + f.size);
        const z = slice.indexOf(0);
        const s = textDecoder.decode(z >= 0 ? slice.subarray(0, z) : slice);
        value = s.length ? s : null;
      } else if (f.size > baseSize && f.size % baseSize === 0) {
        const arr: (number | null)[] = [];
        for (let i = 0; i < f.size / baseSize; i++) {
          const v = readValue(view, pos + i * baseSize, f.base, def.littleEndian);
          arr.push(typeof v === "bigint" ? Number(v) : v);
        }
        value = arr.every((v) => v === null) ? null : arr;
      } else if (f.size === baseSize) {
        value = readValue(view, pos, f.base, def.littleEndian);
      } else {
        // size mismatch: read as raw bytes
        value = Array.from(bytes.subarray(pos, pos + f.size));
      }
      pos += f.size;
      rec.raw[f.num] = value;
      const fp = profile?.fields[f.num];
      const name = fp?.name ?? `field_${f.num}`;
      rec.fields[name] = applyScale(value, fp?.scale, fp?.offset);
      if (f.num === 253 && typeof value === "number") {
        lastTimestamp = value;
        rec.timestamp = value + GARMIN_EPOCH;
      }
    }
    pos += def.devBytes;

    if (rec.timestamp === null && compressedTs !== null) rec.timestamp = compressedTs + GARMIN_EPOCH;
    // DateTime fields -> unix seconds
    if (profile) {
      for (const [numStr, fp] of Object.entries(profile.fields)) {
        if (fp.type !== "DateTime") continue;
        const v = rec.raw[Number(numStr)];
        if (typeof v === "number" && Number(numStr) !== 253) rec.fields[fp.name] = v + GARMIN_EPOCH;
      }
    }
    if (rec.timestamp !== null) rec.fields.timestamp = rec.timestamp;
    records.push(rec);
  }
}

function applyScale(v: FitValue, scale?: number, offset?: number): FitValue {
  if (v === null || typeof v === "string" || typeof v === "bigint") return v;
  if (!scale && !offset) return v;
  const s = scale ?? 1;
  const o = offset ?? 0;
  if (Array.isArray(v)) return v.map((x) => (x === null ? null : x / s - o));
  return v / s - o;
}

export const num = (v: FitValue | undefined): number | null => (typeof v === "number" ? v : null);
