export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry {
  ts: number;
  level: LogLevel;
  source: string;
  msg: string;
}

const MAX = 3000;
const entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let snapshot: LogEntry[] = [];

export const logStore = {
  add(level: LogLevel, source: string, msg: string) {
    entries.push({ ts: Date.now(), level, source, msg });
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    snapshot = entries.slice();
    listeners.forEach((l) => l());
    if (level === "error") console.error(`[${source}] ${msg}`);
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => snapshot,
  clear() {
    entries.length = 0;
    snapshot = [];
    listeners.forEach((l) => l());
  },
  asText: () =>
    entries.map((e) => `${new Date(e.ts).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.msg}`).join("\n"),
};

export const log = (source: string) => ({
  debug: (m: string) => logStore.add("debug", source, m),
  info: (m: string) => logStore.add("info", source, m),
  warn: (m: string) => logStore.add("warn", source, m),
  error: (m: string) => logStore.add("error", source, m),
});
