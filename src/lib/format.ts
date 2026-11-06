// "always": 4.106 like Gadgetbridge (Italian default groups only from 5 digits)
const nf = new Intl.NumberFormat("it-IT", { useGrouping: "always" } as unknown as Intl.NumberFormatOptions);
const nf1 = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 2 });

export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? "–" : nf.format(Math.round(n)));
export const fmt1 = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? "–" : nf1.format(n));
export const fmt2 = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? "–" : nf2.format(n));

export function fmtDistance(m: number | null | undefined) {
  if (m === null || m === undefined) return "–";
  return m >= 1000 ? `${nf2.format(m / 1000)} km` : `${nf.format(Math.round(m))} m`;
}

export function fmtMinutes(min: number | null | undefined) {
  if (min === null || min === undefined || Number.isNaN(min)) return "–";
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

export function fmtDuration(sec: number | null | undefined) {
  if (sec === null || sec === undefined) return "–";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

export const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
export const fmtDay = (ts: number) => new Date(ts * 1000).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" });
export const fmtDayLong = (ts: number) => new Date(ts * 1000).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
export const fmtDateTime = (ts: number) =>
  new Date(ts * 1000).toLocaleString("it-IT", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const fmtWeekday = (ts: number) => new Date(ts * 1000).toLocaleDateString("it-IT", { weekday: "narrow" });
export const fmtDayNum = (ts: number) => new Date(ts * 1000).getDate().toString();

export function fmtRelative(ts: number | null | undefined) {
  if (!ts) return "mai";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "adesso";
  if (diff < 3600) return `${Math.floor(diff / 60)} min fa`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h fa`;
  return fmtDay(ts);
}

export function fmtPace(speed: number | null | undefined) {
  if (!speed) return "–";
  const secPerKm = Math.round(1000 / speed);
  return `${Math.floor(secPerKm / 60)}:${String(secPerKm % 60).padStart(2, "0")} /km`;
}

/** 1234 -> "20 min 34 s", 4000 -> "1 h 06 min" (Gadgetbridge style, for tiles) */
export function fmtDurationWords(sec: number | null | undefined) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return "–";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} h ${String(m).padStart(2, "0")} min`;
  return m ? `${m} min ${s % 60} s` : `${s} s`;
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${nf1.format(n / 1024)} KB`;
  return `${nf1.format(n / 1024 / 1024)} MB`;
}
