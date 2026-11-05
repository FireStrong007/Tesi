import { describe, expect, it } from "vitest";
import { fromHex } from "../src/lib/bytes";
import { CAPABILITIES, capabilitiesFromBinary, capabilitiesToBinary, ourCapabilities } from "../src/lib/garmin/capabilities";
import { CobsStreamDecoder, cobsDecodeFrame, cobsEncode } from "../src/lib/garmin/cobs";
import { crc16 } from "../src/lib/garmin/crc";
import { Msg, buildMessage, nextDstTransitions, out, parseMessage, parseStatus } from "../src/lib/garmin/gfdi";
import { parseSmartBattery, pbDecode, pbEncode, smartBatteryRequest } from "../src/lib/garmin/protobuf";

describe("crc16", () => {
  it("matches the FIT reference value for a 12-byte header", () => {
    // FIT SDK example header: 0e 10 98 00 ... ; known property: crc of data+crc == 0
    const data = new TextEncoder().encode("123456789");
    const c = crc16(data);
    const withCrc = new Uint8Array([...data, c & 0xff, c >> 8]);
    expect(crc16(withCrc)).toBe(0);
    expect(c).toBe(0xbb3d); // CRC-16/ARC check value
  });
});

describe("COBS", () => {
  const cases = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([1, 2, 3]),
    new Uint8Array([0, 0, 1, 0]),
    new Uint8Array([1, 2, 0]),
    Uint8Array.from({ length: 600 }, (_, i) => (i % 7 === 0 ? 0 : i & 0xff)),
    Uint8Array.from({ length: 700 }, (_, i) => (i % 255) + 1), // long run without zeros
  ];
  it("round-trips arbitrary payloads", () => {
    for (const c of cases) {
      const enc = cobsEncode(c);
      expect(enc[0]).toBe(0);
      expect(enc[enc.length - 1]).toBe(0);
      expect(enc.subarray(1, enc.length - 1).includes(0)).toBe(false);
      expect(Array.from(cobsDecodeFrame(enc)!)).toEqual(Array.from(c));
    }
  });
  it("reassembles fragmented frames", () => {
    const a = cobsEncode(new Uint8Array([5, 0, 6, 7]));
    const b = cobsEncode(Uint8Array.from({ length: 300 }, (_, i) => i & 0xff));
    const stream = new Uint8Array([...a, ...b]);
    const dec = new CobsStreamDecoder();
    const got: Uint8Array[] = [];
    for (let i = 0; i < stream.length; i += 19) got.push(...dec.push(stream.subarray(i, i + 19)));
    expect(got).toHaveLength(2);
    expect(Array.from(got[0])).toEqual([5, 0, 6, 7]);
    expect(got[1].length).toBe(300);
  });
});

describe("GFDI framing", () => {
  it("builds messages with length and CRC that parse back", () => {
    const m = out.systemEvent(8, 0);
    expect(m.length).toBe(2 + 2 + 2 + 2);
    const p = parseMessage(m);
    expect(p.type).toBe(Msg.SYSTEM_EVENT);
    expect(p.reader.u8()).toBe(8);
  });
  it("decodes compact message ids (0x8000 flag)", () => {
    const raw = buildMessage(0x8000 | (Msg.DEVICE_INFORMATION - 5000));
    expect(parseMessage(raw).type).toBe(Msg.DEVICE_INFORMATION);
  });
  it("rejects a corrupted CRC", () => {
    const m = out.status(Msg.CONFIGURATION);
    m[m.length - 1] ^= 0xff;
    expect(() => parseMessage(m)).toThrow();
  });
  it("encodes status responses like Gadgetbridge", () => {
    const m = out.status(Msg.CONFIGURATION);
    // 09 00 | 88 13 (5000) | ba 13 (5050) | 00 | crc
    expect(Array.from(m.subarray(0, 7))).toEqual([9, 0, 0x88, 0x13, 0xba, 0x13, 0]);
    const s = parseStatus(parseMessage(m).reader);
    expect(s.originalType).toBe(Msg.CONFIGURATION);
  });
  it("download request has GB's 14 byte payload layout", () => {
    const m = out.downloadRequest(0x0012);
    expect(m.length).toBe(2 + 2 + 14 + 2);
    expect(Array.from(m.subarray(4, 8))).toEqual([0x12, 0, 0, 0]);
  });
  it("finds the next DST transitions in Europe/Rome", () => {
    const { nextStart, nextEnd } = nextDstTransitions(new Date("2026-11-02T12:00:00+01:00"));
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/Rome") {
      expect(new Date(nextStart! * 1000).toISOString()).toBe("2027-03-28T01:00:00.000Z");
      expect(new Date(nextEnd! * 1000).toISOString()).toBe("2027-10-31T01:00:00.000Z");
    }
  });
});

describe("capabilities", () => {
  it("has the same ordinal layout as Gadgetbridge", () => {
    expect(CAPABILITIES.length).toBe(129);
    expect(CAPABILITIES.indexOf("GENERIC_CREDENTIALS")).toBe(99);
    expect(CAPABILITIES.indexOf("MULTI_LINK_SERVICE")).toBe(76);
  });
  it("round-trips the bitmask", () => {
    const caps = ourCapabilities("gadgetbridge");
    const bin = capabilitiesToBinary(caps);
    expect(bin.length).toBe(17);
    expect(capabilitiesFromBinary(bin).size).toBe(caps.size);
    expect(caps.has("GPS_EPHEMERIS_DOWNLOAD")).toBe(false);
  });
});

describe("protobuf", () => {
  it("encodes the battery request like GB", () => {
    expect(Array.from(smartBatteryRequest())).toEqual([0x42, 0x02, 0x12, 0x00]);
  });
  it("parses a battery response", () => {
    const resp = pbEncode([[8, [[3, [[1, 1], [2, 87], [3, 1]]]]]]);
    expect(parseSmartBattery(resp)?.level).toBe(87);
    expect(pbDecode(fromHex("0805")).get(1)).toEqual([5]);
  });
});
