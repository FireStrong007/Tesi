/**
 * The server's only logger. Every line goes through redact(): fields whose name looks secret
 * (password, token, cookie, authorization, csrf, secret) are replaced, and so is any registered
 * secret value (backup credentials, admin password) wherever it appears in the text. Nothing else
 * in the server writes to the console.
 */
export type Level = "info" | "warn" | "error";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** hides this value in every later line */
  addSecret(value: string): void;
}

export const HIDDEN = "[nascosto]";
const SECRET_KEY = /pass(word)?|token|secret|cookie|authorization|csrf|credential|api[_-]?key/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object") {
    // a yes/no setting (e.g. secureCookies) cannot be a secret
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v !== "boolean" ? HIDDEN : scrub(v, depth + 1)]));
  }
  return value;
}

export function createLogger(opts: { sink?: (line: string, level: Level) => void; secrets?: string[] } = {}): Logger {
  const secrets = new Set<string>();
  const add = (s: string) => {
    // very short values would hide ordinary words
    if (s && s.length >= 4) secrets.add(s);
  };
  (opts.secrets ?? []).forEach(add);
  const sink = opts.sink ?? ((line, level) => (level === "info" ? console.log(line) : console.error(line)));
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    let line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
    if (fields && Object.keys(fields).length) line += ` ${JSON.stringify(scrub(fields))}`;
    for (const s of secrets) line = line.split(s).join(HIDDEN);
    sink(line, level);
  };
  return {
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    addSecret: add,
  };
}
