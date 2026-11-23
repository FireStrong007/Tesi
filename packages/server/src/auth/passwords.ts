/**
 * Passwords: scrypt (node:crypto) with a random salt, stored as
 * scrypt$N$r$p$salt$hash (base64). Never stored or logged in clear text.
 */
import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
// 128 * N * r bytes are needed: 32 MiB, plus headroom
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFC"), salt, KEY_LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64");
  const want = Buffer.from(parts[5], "base64");
  const got = await scrypt(password.normalize("NFC"), salt, want.length, { N: n, r, p, maxmem: MAXMEM });
  return got.length === want.length && timingSafeEqual(got, want);
}

let dummy: Promise<string> | null = null;
/**
 * A hash to check against when the username does not exist, so that the answer takes the same
 * time and does not reveal which usernames exist.
 */
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString("hex")));

// no 0/O, 1/l/I: easy to read aloud and to type on a phone
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const TEMP_PASSWORD_LENGTH = 12;

export function temporaryPassword(): string {
  let out = "";
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export const MIN_PASSWORD_LENGTH = 10;

/** Why a new password is not acceptable, or null. */
export function passwordProblem(password: string, username: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `La password deve avere almeno ${MIN_PASSWORD_LENGTH} caratteri.`;
  if (password.length > 200) return "La password è troppo lunga (massimo 200 caratteri).";
  if (password.trim().toLowerCase() === username.toLowerCase()) return "La password non può essere uguale al nome utente.";
  return null;
}
