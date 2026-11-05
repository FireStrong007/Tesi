/**
 * Little-endian binary reader/writer used by the Garmin GFDI protocol and the FIT decoder.
 */

const textDecoder = new TextDecoder("utf-8");
const textEncoder = new TextEncoder();

export class ByteReader {
  private view: DataView;
  pos = 0;
  limit: number;

  constructor(public readonly bytes: Uint8Array, littleEndian = true) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.limit = bytes.byteLength;
    this.le = littleEndian;
  }

  le: boolean;

  remaining(): number {
    return this.limit - this.pos;
  }

  private need(n: number) {
    if (this.pos + n > this.limit) {
      throw new RangeError(`Lettura oltre la fine del buffer (pos=${this.pos}, n=${n}, limit=${this.limit})`);
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, this.le);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, this.le);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, this.le);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, this.le);
    this.pos += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, this.le);
    this.pos += 8;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, this.le);
    this.pos += 8;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, this.le);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, this.le);
    this.pos += 8;
    return v;
  }
  bytesN(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** Garmin string: 1 byte length prefix followed by UTF-8 bytes */
  string(): string {
    const len = this.u8();
    return textDecoder.decode(this.bytesN(len));
  }
  skip(n: number) {
    this.need(n);
    this.pos += n;
  }
}

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  pos = 0;

  constructor(initial = 256, private le = true) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number) {
    this.ensure(1);
    this.view.setUint8(this.pos++, v & 0xff);
    return this;
  }
  i8(v: number) {
    this.ensure(1);
    this.view.setInt8(this.pos++, v);
    return this;
  }
  u16(v: number) {
    this.ensure(2);
    this.view.setUint16(this.pos, v & 0xffff, this.le);
    this.pos += 2;
    return this;
  }
  i16(v: number) {
    this.ensure(2);
    this.view.setInt16(this.pos, v, this.le);
    this.pos += 2;
    return this;
  }
  u32(v: number) {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, this.le);
    this.pos += 4;
    return this;
  }
  i32(v: number) {
    this.ensure(4);
    this.view.setInt32(this.pos, v | 0, this.le);
    this.pos += 4;
    return this;
  }
  u64(v: bigint) {
    this.ensure(8);
    this.view.setBigUint64(this.pos, v, this.le);
    this.pos += 8;
    return this;
  }
  f32(v: number) {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, this.le);
    this.pos += 4;
    return this;
  }
  f64(v: number) {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, this.le);
    this.pos += 8;
    return this;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }
  string(s: string) {
    const b = textEncoder.encode(s);
    if (b.length > 255) throw new RangeError("Stringa troppo lunga");
    this.u8(b.length);
    this.bytes(b);
    return this;
  }
  /** overwrite a u16 at an absolute position */
  setU16At(at: number, v: number) {
    this.view.setUint16(at, v & 0xffff, this.le);
  }
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function hex(bytes: Uint8Array, max = 512): string {
  const parts: string[] = [];
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i++) parts.push(bytes[i].toString(16).padStart(2, "0"));
  return parts.join("") + (bytes.length > max ? `…(+${bytes.length - max})` : "");
}

export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/[^0-9a-f]/gi, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
