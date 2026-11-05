/**
 * Test helper: writes zips like Java's ZipOutputStream (what Gadgetbridge uses): deflated entries
 * with general-purpose flag bit 3, sizes 0 in the local header and the real sizes in a data
 * descriptor and in the central directory.
 */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function writeZip(files: { name: string; data: Uint8Array; store?: boolean }[]): Promise<Uint8Array> {
  const out: number[] = [];
  const central: number[] = [];
  const le16 = (a: number[], v: number) => a.push(v & 0xff, (v >> 8) & 0xff);
  const le32 = (a: number[], v: number) => a.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const comp = f.store ? f.data : await deflateRaw(f.data);
    const method = f.store ? 0 : 8;
    const crc = crc32(f.data);
    const offset = out.length;
    const flags = f.store ? 0 : 0x0008;
    le32(out, 0x04034b50); le16(out, 20); le16(out, flags); le16(out, method); le16(out, 0x6000); le16(out, 0x5b62);
    le32(out, f.store ? crc : 0); le32(out, f.store ? comp.length : 0); le32(out, f.store ? f.data.length : 0);
    le16(out, name.length); le16(out, 0); out.push(...name, ...comp);
    if (!f.store) { le32(out, 0x08074b50); le32(out, crc); le32(out, comp.length); le32(out, f.data.length); }
    le32(central, 0x02014b50); le16(central, 20); le16(central, 20); le16(central, flags); le16(central, method);
    le16(central, 0x6000); le16(central, 0x5b62); le32(central, crc); le32(central, comp.length); le32(central, f.data.length);
    le16(central, name.length); le16(central, 0); le16(central, 0); le16(central, 0); le16(central, 0); le32(central, 0);
    le32(central, offset); central.push(...name);
  }
  const cdOffset = out.length;
  out.push(...central);
  le32(out, 0x06054b50); le16(out, 0); le16(out, 0); le16(out, files.length); le16(out, files.length);
  le32(out, central.length); le32(out, cdOffset); le16(out, 0);
  return Uint8Array.from(out);
}
