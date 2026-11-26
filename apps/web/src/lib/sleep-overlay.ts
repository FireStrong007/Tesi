/**
 * The sleep stages chart with a measure on top (heart rate, SpO2, breathing): the plot area, the
 * right axis of each measure and the tiles under the chart. Pure functions, tested in tests/.
 */
import { stats } from "@bridge/core/metrics";
import { fmt1, fmtInt } from "@bridge/core/format";

export type OverlayId = "hr" | "spo2" | "resp";

/**
 * Space around the plot (px). The right axis and the line above the plot (its unit) are always
 * reserved, with or without a measure on top: switching one on or off never moves the chart.
 */
export const HYPNOGRAM_PAD = { left: 62, right: 34, top: 14, bottom: 20 } as const;

/** the plot area of a hypnogram `width` px wide: the same with or without a measure on top */
export const hypnogramPlot = (width: number) => ({ left: HYPNOGRAM_PAD.left, width: Math.max(1, width - HYPNOGRAM_PAD.left - HYPNOGRAM_PAD.right) });

/** each measure's fixed scale, widened only when a value falls outside; SpO2 never above 100 */
const SCALES: Record<OverlayId, { lo: number; hi: number; step: number; unit: string; max?: number }> = {
  hr: { lo: 40, hi: 100, step: 20, unit: "bpm" },
  spo2: { lo: 85, hi: 100, step: 5, unit: "%", max: 100 },
  resp: { lo: 8, hi: 24, step: 4, unit: "resp/min" },
};

export interface OverlayScale {
  lo: number;
  hi: number;
  /** the values with a label on the right axis, from lo to hi (at least one in between) */
  ticks: number[];
  unit: string;
}

export function overlayScale(id: OverlayId, values: readonly number[]): OverlayScale {
  const s = SCALES[id];
  let lo = s.lo;
  let hi = s.hi;
  for (const v of values) {
    if (v < lo) lo = Math.floor(v / s.step) * s.step;
    if (v > hi) hi = Math.ceil(v / s.step) * s.step;
  }
  if (s.max != null) hi = Math.min(hi, s.max);
  // not more than 6 labels: a wider scale takes a larger step
  let step = s.step;
  while ((hi - lo) / step > 5) step *= 2;
  // the top on a step too, so the labels are evenly spaced (SpO2 still not above 100)
  hi = lo + Math.ceil((hi - lo) / step) * step;
  if (s.max != null) hi = Math.min(hi, s.max);
  const ticks: number[] = [];
  for (let v = lo; v < hi; v += step) ticks.push(v);
  ticks.push(hi);
  return { lo, hi, ticks, unit: s.unit };
}

export interface NightTile {
  label: string;
  value: string;
  unit: string;
  color: string;
}

const MEASURES: Record<OverlayId, { name: string; female: boolean; unit: string; color: string; fmt: (v: number | null) => string }> = {
  hr: { name: "Battito", female: false, unit: "bpm", color: "var(--heart)", fmt: fmtInt },
  spo2: { name: "SpO₂", female: true, unit: "%", color: "var(--spo2)", fmt: fmtInt },
  resp: { name: "Respirazione", female: true, unit: "resp/min", color: "var(--resp)", fmt: fmt1 },
};

/**
 * The tiles under the chart: minimum, maximum and average of the measure on top; with none, the
 * night's average of each measure that has data.
 */
export function nightTiles(overlay: OverlayId | null, night: Record<OverlayId, readonly number[]>): NightTile[] {
  if (overlay) {
    const m = MEASURES[overlay];
    const s = stats([...night[overlay]]);
    const a = (masc: string, fem: string) => `${m.name} ${m.female ? fem : masc}`;
    return [
      { label: a("minimo", "minima"), value: m.fmt(s.min), unit: m.unit, color: m.color },
      { label: a("massimo", "massima"), value: m.fmt(s.max), unit: m.unit, color: m.color },
      { label: a("medio", "media"), value: m.fmt(s.avg), unit: m.unit, color: m.color },
    ];
  }
  return (["hr", "spo2", "resp"] as const)
    .filter((id) => night[id].length > 0)
    .map((id) => {
      const m = MEASURES[id];
      return { label: `${m.name} ${m.female ? "media" : "medio"}`, value: m.fmt(stats([...night[id]]).avg), unit: m.unit, color: m.color };
    });
}
