/**
 * COBS framing as used by Garmin's GFDI over the Multi-Link BLE service.
 * Each frame is: 0x00, COBS-encoded payload, 0x00.
 * Ported from Gadgetbridge's CobsCoDec (AGPL-3.0).
 */

export function cobsEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [0]; // Garmin leading zero
  let pos = 0;
  let lastByteWasZero = false;
  while (pos < data.length) {
    const start = pos;
    let zeroIndex = pos;
    // advance until a zero byte (consumed) or the end
    while (pos < data.length) {
      const b = data[pos++];
      if (b === 0) break;
      zeroIndex++;
    }
    lastByteWasZero = pos > zeroIndex;
    let payloadSize = zeroIndex - start;
    let s = start;
    while (payloadSize >= 0xfe) {
      out.push(0xff);
      for (let i = 0; i < 0xfe; i++) out.push(data[s + i]);
      payloadSize -= 0xfe;
      s += 0xfe;
    }
    out.push(payloadSize + 1);
    for (let i = 0; i < payloadSize; i++) out.push(data[s + i]);
  }
  if (lastByteWasZero) out.push(0x01);
  out.push(0);
  return Uint8Array.from(out);
}

/** Decodes a full frame (including the leading and trailing 0x00). Returns null if malformed. */
export function cobsDecodeFrame(frame: Uint8Array): Uint8Array | null {
  if (frame.length < 2 || frame[0] !== 0 || frame[frame.length - 1] !== 0) return null;
  const end = frame.length - 1; // exclude trailing 0
  const out: number[] = [];
  let i = 1;
  while (i < end) {
    const code = frame[i++];
    if (code === 0) break;
    const payload = code - 1;
    if (i + payload > end) return null;
    for (let k = 0; k < payload; k++) out.push(frame[i++]);
    if (code !== 0xff && i < end) out.push(0);
  }
  return Uint8Array.from(out);
}

/**
 * Streaming decoder: feed BLE notification fragments, get complete messages out.
 */
export class CobsStreamDecoder {
  private buf: number[] = [];

  push(chunk: Uint8Array): Uint8Array[] {
    const messages: Uint8Array[] = [];
    for (const b of chunk) {
      if (this.buf.length === 0) {
        // a frame must start with 0x00; ignore garbage until then
        if (b === 0) this.buf.push(0);
        continue;
      }
      this.buf.push(b);
      if (b === 0 && this.buf.length > 1) {
        if (this.buf.length === 2) {
          // two zeros in a row: treat second zero as the start of a new frame
          this.buf = [0];
          continue;
        }
        const decoded = cobsDecodeFrame(Uint8Array.from(this.buf));
        this.buf = [];
        if (decoded && decoded.length > 0) messages.push(decoded);
      }
    }
    return messages;
  }

  reset() {
    this.buf = [];
  }
}
