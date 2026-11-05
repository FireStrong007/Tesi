/**
 * Minimal protobuf (proto2 wire format) encoder/decoder - enough for the few
 * Garmin "Smart" RPC messages this app uses (battery status, find my watch).
 * Field numbers come from Gadgetbridge's gdi_*.proto files.
 */

export type PbValue = number | bigint | Uint8Array;
export type PbMessage = Map<number, PbValue[]>;

export function encodeVarint(value: number | bigint): number[] {
  let v = BigInt(value);
  if (v < 0n) v = (1n << 64n) + v;
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return out;
}

export type PbField = [field: number, value: number | Uint8Array | PbField[]];

/** Encode a nested description: [[1, 5], [2, [[1, 3]]]] -> bytes. Sub-arrays become length-delimited submessages. */
export function pbEncode(fields: PbField[]): Uint8Array {
  const out: number[] = [];
  for (const [num, val] of fields) {
    if (typeof val === "number") {
      out.push(...encodeVarint((num << 3) | 0), ...encodeVarint(val));
    } else {
      const bytes = val instanceof Uint8Array ? val : pbEncode(val);
      out.push(...encodeVarint((num << 3) | 2), ...encodeVarint(bytes.length), ...bytes);
    }
  }
  return Uint8Array.from(out);
}

export function pbDecode(bytes: Uint8Array): PbMessage {
  const res: PbMessage = new Map();
  let i = 0;
  const readVarint = (): bigint => {
    let shift = 0n;
    let result = 0n;
    while (i < bytes.length) {
      const b = bytes[i++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error("varint troncato");
  };
  const push = (k: number, v: PbValue) => {
    const arr = res.get(k);
    if (arr) arr.push(v);
    else res.set(k, [v]);
  };
  while (i < bytes.length) {
    const key = Number(readVarint());
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      const v = readVarint();
      push(field, v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);
    } else if (wire === 2) {
      const len = Number(readVarint());
      push(field, bytes.slice(i, i + len));
      i += len;
    } else if (wire === 5) {
      push(field, bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
      i += 4;
    } else if (wire === 1) {
      push(field, bytes.slice(i, i + 8));
      i += 8;
    } else {
      throw new Error(`wire type protobuf non supportato: ${wire}`);
    }
  }
  return res;
}

export function pbGetMessage(m: PbMessage | undefined, field: number): PbMessage | undefined {
  const v = m?.get(field)?.[0];
  return v instanceof Uint8Array ? pbDecode(v) : undefined;
}

export function pbGetNumber(m: PbMessage | undefined, field: number): number | undefined {
  const v = m?.get(field)?.[0];
  return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined;
}

// --- Garmin Smart RPC helpers -------------------------------------------------

/** Smart.device_status_service(8).remote_device_battery_status_request(2) */
export const smartBatteryRequest = () => pbEncode([[8, [[2, []]]]]);

/** Smart.find_my_watch_service(12).find_request(1){timeout(1)} */
export const smartFindWatch = (timeoutSec: number) => pbEncode([[12, [[1, [[1, timeoutSec]]]]]]);

/** Smart.find_my_watch_service(12).cancel_request(3) */
export const smartFindWatchCancel = () => pbEncode([[12, [[3, []]]]]);

export interface SmartBattery {
  level?: number;
  status?: number;
  hoursRemaining?: number;
}

/** Extracts battery info from a Smart message if present (response or changed notification). */
export function parseSmartBattery(smart: Uint8Array): SmartBattery | null {
  const root = pbDecode(smart);
  const svc = pbGetMessage(root, 8);
  if (!svc) return null;
  const resp = pbGetMessage(svc, 3);
  if (resp) {
    return { level: pbGetNumber(resp, 2), status: pbGetNumber(resp, 3), hoursRemaining: pbGetNumber(resp, 4) };
  }
  const notif = pbGetMessage(svc, 1);
  if (notif) return { status: pbGetNumber(notif, 1) };
  return null;
}
