/**
 * Small FIT encoder. Used to build synthetic files for the demo mode and tests,
 * so the demo data travels through exactly the same decode + import path as real data.
 */
import { ByteWriter } from "../bytes";
import { crc16 } from "../garmin/crc";
import { GARMIN_EPOCH } from "../garmin/time";
import { BaseType } from "./decoder";

type Base = (typeof BaseType)[keyof typeof BaseType];

export interface EncField {
  num: number;
  base: Base;
  /** raw (unscaled) value; null writes the invalid value; for STRING pass size; an array writes an array field */
  value: number | string | null | (number | null)[];
  size?: number;
}

const SIZE: Record<number, number> = {
  0x00: 1, 0x01: 1, 0x02: 1, 0x83: 2, 0x84: 2, 0x85: 4, 0x86: 4, 0x07: 1, 0x88: 4, 0x89: 8, 0x0a: 1, 0x8b: 2, 0x8c: 4, 0x0d: 1,
};
const INVALID: Record<number, number> = {
  0x00: 0xff, 0x01: 0x7f, 0x02: 0xff, 0x83: 0x7fff, 0x84: 0xffff, 0x85: 0x7fffffff, 0x86: 0xffffffff, 0x0a: 0, 0x8b: 0, 0x8c: 0, 0x0d: 0xff,
};

export class FitEncoder {
  private w = new ByteWriter(4096);
  private defined = new Map<number, string>();

  /** Writes a message; definitions are emitted automatically (local type 0..15 by global number). */
  write(globalNum: number, fields: EncField[]) {
    const local = globalNum % 16;
    const sizeOf = (f: EncField) => f.size ?? (Array.isArray(f.value) ? f.value.length * SIZE[f.base] : SIZE[f.base]);
    const sig = globalNum + ":" + fields.map((f) => `${f.num}/${f.base}/${sizeOf(f)}`).join(",");
    if (this.defined.get(local) !== sig) {
      this.w.u8(0x40 | local);
      this.w.u8(0);
      this.w.u8(0); // little endian
      this.w.u16(globalNum);
      this.w.u8(fields.length);
      for (const f of fields) {
        this.w.u8(f.num);
        this.w.u8(sizeOf(f));
        this.w.u8(f.base);
      }
      this.defined.set(local, sig);
    }
    this.w.u8(local);
    for (const f of fields) this.writeValue(f);
  }

  private writeValue(f: EncField) {
    const v = f.value;
    if (Array.isArray(v)) {
      for (const x of v) this.writeValue({ num: f.num, base: f.base, value: x });
      return;
    }
    if (f.base === BaseType.STRING) {
      const size = f.size ?? 16;
      const bytes = new TextEncoder().encode(String(v ?? ""));
      for (let i = 0; i < size; i++) this.w.u8(i < bytes.length && i < size - 1 ? bytes[i] : 0);
      return;
    }
    const raw = v === null ? INVALID[f.base] : Number(v);
    switch (f.base) {
      case BaseType.SINT8:
        this.w.i8(raw);
        break;
      case BaseType.SINT16:
        this.w.i16(raw);
        break;
      case BaseType.SINT32:
        this.w.i32(raw);
        break;
      case BaseType.UINT16:
      case BaseType.UINT16Z:
        this.w.u16(raw);
        break;
      case BaseType.UINT32:
      case BaseType.UINT32Z:
        this.w.u32(raw);
        break;
      case BaseType.FLOAT32:
        this.w.f32(raw);
        break;
      case BaseType.FLOAT64:
        this.w.f64(raw);
        break;
      default:
        this.w.u8(raw);
    }
  }

  finish(): Uint8Array {
    const data = this.w.toBytes();
    const header = new ByteWriter(14);
    header.u8(14);
    header.u8(0x20); // protocol 2.0
    header.u16(2132);
    header.u32(data.length);
    header.bytes(new TextEncoder().encode(".FIT"));
    const h = header.toBytes();
    header.u16(crc16(h));
    const full = new ByteWriter(data.length + 16);
    full.bytes(header.toBytes());
    full.bytes(data);
    const sofar = full.toBytes();
    full.u16(crc16(sofar));
    return full.toBytes();
  }
}

export const toGarminTs = (unix: number) => Math.round(unix) - GARMIN_EPOCH;
