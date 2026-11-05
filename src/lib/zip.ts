/**
 * Minimal ZIP reader for the browser (and Node 18+): central directory, stored and
 * deflated entries, ZIP64. Reads the archive in slices, so large exports (e.g. a
 * Gadgetbridge backup with years of files) are never loaded into memory at once.
 * Decompression uses the platform's DecompressionStream("deflate-raw").
 */

export interface ZipSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function sourceFromBlob(blob: Blob): ZipSource {
  return {
    size: blob.size,
    read: async (o, l) => new Uint8Array(await blob.slice(o, o + l).arrayBuffer()),
  };
}

export function sourceFromBytes(bytes: Uint8Array): ZipSource {
  return { size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) };
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  /** last modification time from the DOS fields (local time), unix seconds */
  mtime: number;
  isDirectory: boolean;
}

export class ZipError extends Error {}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

function dosTime(time: number, date: number): number {
  const d = new Date(1980 + (date >> 9), ((date >> 5) & 0xf) - 1, date & 0x1f, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2);
  return Math.floor(d.getTime() / 1000);
}

/** Lists the archive's entries from its central directory. */
export async function listZip(src: ZipSource): Promise<ZipEntry[]> {
  // End of central directory: last 22 bytes + up to 64 KB comment
  const tailLen = Math.min(src.size, 22 + 65535 + 20);
  const tail = await src.read(src.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("Non è un file zip valido");
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  // ZIP64 end of central directory locator just before the EOCD
  if (eocd >= 20 && u32(tail, eocd - 20) === 0x07064b50) {
    const z64Offset = u64(tail, eocd - 20 + 8);
    const z64 = await src.read(z64Offset, 56);
    if (u32(z64, 0) !== 0x06064b50) throw new ZipError("Zip64 non valido");
    count = u64(z64, 32);
    cdSize = u64(z64, 40);
    cdOffset = u64(z64, 48);
  }
  const cd = await src.read(cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  const dec = new TextDecoder();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (u32(cd, p) !== 0x02014b50) throw new ZipError("Directory dello zip danneggiata");
    const method = u16(cd, p + 10);
    const time = u16(cd, p + 12);
    const date = u16(cd, p + 14);
    let compressedSize = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let localHeaderOffset = u32(cd, p + 42);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field: only the fields that are 0xffffffff in the header are present, in this order
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) (size = u64(cd, q)), (q += 8);
        if (compressedSize === 0xffffffff) (compressedSize = u64(cd, q)), (q += 8);
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(cd, q);
      }
      e += 4 + len;
    }
    entries.push({ name, method, compressedSize, size, localHeaderOffset, mtime: dosTime(time, date), isDirectory: name.endsWith("/") });
    p = extraEnd + commentLen;
  }
  return entries;
}

/** Extracts one entry. */
export async function readZipEntry(src: ZipSource, entry: ZipEntry): Promise<Uint8Array> {
  const lh = await src.read(entry.localHeaderOffset, 30);
  if (u32(lh, 0) !== 0x04034b50) throw new ZipError(`Intestazione locale non valida per ${entry.name}`);
  const dataStart = entry.localHeaderOffset + 30 + u16(lh, 26) + u16(lh, 28);
  const raw = await src.read(dataStart, entry.compressedSize);
  if (entry.method === 0) return raw.slice();
  if (entry.method !== 8) throw new ZipError(`Metodo di compressione non supportato (${entry.method}) per ${entry.name}`);
  const stream = new Blob([raw.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (entry.size && out.length !== entry.size) throw new ZipError(`Dimensione inattesa per ${entry.name}`);
  return out;
}
