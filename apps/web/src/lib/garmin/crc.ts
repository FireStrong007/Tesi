/**
 * Garmin CRC-16 (nibble table variant), used both for GFDI message checksums
 * and the running CRC of file-transfer chunks. Same algorithm as the FIT file CRC.
 * Ported from Gadgetbridge's ChecksumCalculator (AGPL-3.0).
 */
const CONSTANTS = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000,
  0x9c01, 0x8801, 0x4400,
];

export function crc16(data: Uint8Array, initial = 0, offset = 0, length = data.length - offset): number {
  let crc = initial & 0xffff;
  for (let i = offset; i < offset + length; i++) {
    const b = data[i];
    crc = (((crc >> 4) & 0x0fff) ^ CONSTANTS[crc & 15]) ^ CONSTANTS[b & 15];
    crc = (((crc >> 4) & 0x0fff) ^ CONSTANTS[crc & 15]) ^ CONSTANTS[(b >> 4) & 15];
  }
  return crc & 0xffff;
}
