/**
 * Lightweight SVG charts in the spirit of Gadgetbridge's activity charts:
 * bar chart with goal line, time-series line/area chart, sleep hypnogram,
 * the 24 h "activity & sleep" chart, the dashboard 24 h ring and goal rings.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useSize } from "@/hooks/use-size";
import { cn } from "@/lib/utils";
import { fmtTime } from "@/lib/format";
import type { SleepSegment, TimeValue } from "@/lib/db/repo";

import { STAGE_COLOR, STAGE_LABEL } from "@/lib/colors";
export { STAGE_COLOR, STAGE_LABEL };

function Frame({ height, className, children }: { height: number; className?: string; children: (w: number) => ReactNode }) {
  const [ref, size] = useSize<HTMLDivElement>();
  return (
    <div ref={ref} className={cn("relative w-full select-none", className)} style={{ height }}>
      {size.width > 0 && (
        <svg width={size.width} height={height} className="absolute inset-0 overflow-visible" role="img">
          {children(size.width)}
        </svg>
      )}
    </div>
  );
}

/** rounds up to a "readable" step: 103 -> 120, 47 -> 48, 7300 -> 8000 */
const niceCeil = (v: number) => {
  if (v <= 0) return 1;
  const step = Math.pow(10, Math.floor(Math.log10(v)) - 1) * 2;
  return Math.ceil(v / step) * step;
};
const niceFloor = (v: number) => {
  if (v <= 0) return 0;
  const step = Math.pow(10, Math.floor(Math.log10(v)) - 1) * 2;
  return Math.floor(v / step) * step;
};

/** Rounded axis maximum for a value (402 -> 500, 7300 -> 8000). */
export const niceAxisMax = (v: number) => niceMax(v);

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
};

// ---------------------------------------------------------------- bar chart

export interface BarItem {
  key: string | number;
  label: string;
  value: number;
  /** bottom of the bar (floating bars, e.g. min..max of a day); default 0 */
  base?: number;
  /** extra dot drawn on the bar (e.g. resting heart rate) */
  marker?: number;
  color?: string;
  segments?: { value: number; color: string }[];
}

export interface RefLine {
  value: number;
  color: string;
  label?: string;
}

export function BarChart({
  items,
  height = 200,
  goal,
  color = "var(--primary)",
  format = (v) => String(Math.round(v)),
  selected,
  onSelect,
  labelEvery = 1,
  refLines = [],
  showValues = false,
  valueFormat,
  yMin,
  yMax,
}: {
  items: BarItem[];
  height?: number;
  goal?: number;
  color?: string;
  format?: (v: number) => string;
  selected?: string | number | null;
  onSelect?: (key: string | number) => void;
  labelEvery?: number;
  refLines?: RefLine[];
  /** print the value above each bar (only when bars are wide enough) */
  showValues?: boolean;
  valueFormat?: (v: number) => string;
  yMin?: number;
  yMax?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(goal ?? 0, ...refLines.map((r) => r.value), ...items.map((i) => Math.max(i.value, i.marker ?? 0)));
  const max = yMax ?? niceMax(top * 1.08);
  const min = yMin ?? 0;
  const padL = 40;
  const padB = 22;
  const padT = 8;
  return (
    <Frame height={height}>
      {(w) => {
        const plotW = w - padL;
        const plotH = height - padB - padT;
        const bw = plotW / Math.max(items.length, 1);
        const y = (v: number) => padT + plotH - ((Math.max(min, v) - min) / (max - min || 1)) * plotH;
        const ticks = [min, (min + max) / 2, max];
        const vf = valueFormat ?? format;
        return (
          <g>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={w} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" />
                <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
                  {format(t)}
                </text>
              </g>
            ))}
            {items.map((it, i) => {
              const x = padL + i * bw + bw * 0.15;
              const bwi = bw * 0.7;
              const isSel = selected === it.key;
              let acc = 0;
              return (
                <g
                  key={it.key}
                  onClick={() => onSelect?.(it.key)}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover((h) => (h === i ? null : h))}
                  className={onSelect ? "cursor-pointer" : undefined}
                >
                  <rect x={padL + i * bw} y={padT} width={bw} height={plotH} fill={isSel ? "var(--accent)" : hover === i ? "color-mix(in oklch, var(--accent) 50%, transparent)" : "transparent"} rx={4} />
                  {it.segments ? (
                    it.segments.map((s, k) => {
                      const top = y(acc + s.value);
                      const h = y(acc) - top;
                      acc += s.value;
                      return <rect key={k} x={x} y={top} width={bwi} height={Math.max(0, h)} fill={s.color} />;
                    })
                  ) : (
                    <rect
                      x={x}
                      y={y(it.value)}
                      width={bwi}
                      height={Math.max(it.value > (it.base ?? min) ? 2 : 0, y(it.base ?? min) - y(it.value))}
                      rx={Math.min(3, bwi / 3)}
                      fill={it.color ?? color}
                      opacity={selected != null && !isSel ? 0.55 : 1}
                    />
                  )}
                  {it.marker !== undefined && <circle cx={x + bwi / 2} cy={y(it.marker)} r={Math.max(2.5, Math.min(4.5, bwi / 3))} fill="var(--foreground)" stroke="var(--card)" strokeWidth={1.5} />}
                  {showValues && bw >= 26 && it.value > 0 && (
                    <text x={x + bwi / 2} y={y(it.value) - 4} textAnchor="middle" className="fill-foreground text-[10px] font-medium">
                      {vf(it.value)}
                    </text>
                  )}
                  {(i % labelEvery === 0 || isSel) && (
                    <text x={padL + i * bw + bw / 2} y={height - 6} textAnchor="middle" className={cn("text-[10px]", isSel ? "fill-foreground font-semibold" : "fill-muted-foreground")}>
                      {it.label}
                    </text>
                  )}
                </g>
              );
            })}
            {goal !== undefined && goal > 0 && (
              <g>
                <line x1={padL} x2={w} y1={y(goal)} y2={y(goal)} stroke="var(--goal)" strokeDasharray="5 4" strokeWidth={1.5} />
                <text x={padL + 4} y={y(goal) - 4} className="text-[10px] font-medium" fill="var(--goal)">
                  Obiettivo
                </text>
              </g>
            )}
            {refLines.map((r) => (
              <g key={r.value + (r.label ?? "")}>
                <line x1={padL} x2={w} y1={y(r.value)} y2={y(r.value)} stroke={r.color} strokeDasharray="5 4" strokeWidth={1.25} />
                {r.label && (
                  <text x={padL + 4} y={y(r.value) - 4} className="text-[10px] font-medium" fill={r.color}>
                    {r.label}
                  </text>
                )}
              </g>
            ))}
            {hover !== null && items[hover] && (
              <g pointerEvents="none" transform={`translate(${Math.min(Math.max(padL + hover * bw + bw / 2 - 55, padL), w - 110)},${padT})`}>
                <rect width={110} height={36} rx={6} fill="var(--popover)" stroke="var(--border)" />
                <text x={8} y={14} className="fill-muted-foreground text-[10px]">
                  {items[hover].label}
                </text>
                <text x={8} y={29} className="fill-foreground text-[11px] font-semibold">
                  {items[hover].base !== undefined ? `${vf(items[hover].base!)} – ${vf(items[hover].value)}` : vf(items[hover].value)}
                </text>
              </g>
            )}
          </g>
        );
      }}
    </Frame>
  );
}

// ---------------------------------------------------------------- time series

export interface Series {
  points: TimeValue[];
  color: string;
  label?: string;
  area?: boolean;
  /** break the line when two points are further apart than this (seconds) */
  gap?: number;
  dots?: boolean;
  width?: number;
  /** "step": value holds until the next point (cumulative totals); "bars": one column per point */
  kind?: "line" | "step" | "bars";
  /** per-point color for "bars" */
  colorOf?: (v: number) => string;
}

export interface Band {
  start: number;
  end: number;
  color: string;
}

export function TimeChart({
  series,
  from,
  to,
  height = 180,
  yMin,
  yMax,
  bands = [],
  format = (v) => String(Math.round(v)),
  xTicks = "hours",
  refLines = [],
}: {
  series: Series[];
  from: number;
  to: number;
  height?: number;
  yMin?: number;
  yMax?: number;
  bands?: Band[];
  format?: (v: number) => string;
  xTicks?: "hours" | "days";
  refLines?: RefLine[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const all = series.flatMap((s) => s.points.map((p) => p.value));
  const lo = yMin ?? (all.length ? niceFloor(Math.min(...all) * 0.95) : 0);
  const hi = yMax ?? (all.length ? niceCeil(Math.max(...all) * 1.05) : 100);
  const padL = 36;
  const padB = 20;
  const padT = 8;
  const ticks = useMemo(() => {
    const out: number[] = [];
    if (xTicks === "hours") {
      const span = to - from;
      const step = span <= 6 * 3600 ? 3600 : span <= 13 * 3600 ? 2 * 3600 : 6 * 3600;
      const d = new Date(from * 1000);
      d.setMinutes(0, 0, 0);
      for (let t = d.getTime() / 1000; t <= to; t += 3600) {
        if (t >= from && new Date(t * 1000).getHours() % (step / 3600) === 0) out.push(t);
      }
    } else {
      for (let t = from; t <= to; t += 86400) out.push(t);
    }
    return out;
  }, [from, to, xTicks]);

  return (
    <Frame height={height}>
      {(w) => {
        const plotW = w - padL - 4;
        const plotH = height - padB - padT;
        const x = (t: number) => padL + ((t - from) / (to - from)) * plotW;
        const y = (v: number) => padT + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
        const paths = series.map((s) => {
          let d = "";
          let area = "";
          let segStart: number | null = null;
          let prev: TimeValue | null = null;
          for (const p of s.points) {
            const brk = !prev || (s.gap !== undefined && p.timestamp - prev.timestamp > s.gap);
            if (s.kind === "step" && prev && !brk) {
              d += `L${x(p.timestamp)},${y(prev.value)}`;
              if (s.area) area += `L${x(p.timestamp)},${y(prev.value)}`;
            }
            if (brk) {
              if (prev && segStart !== null && s.area) area += `L${x(prev.timestamp)},${y(lo)}L${segStart},${y(lo)}Z`;
              d += `M${x(p.timestamp)},${y(p.value)}`;
              segStart = x(p.timestamp);
            } else d += `L${x(p.timestamp)},${y(p.value)}`;
            if (s.area) area += `${brk ? "M" : "L"}${x(p.timestamp)},${y(p.value)}`;
            prev = p;
          }
          if (s.area && prev && segStart !== null) area += `L${x(prev.timestamp)},${y(lo)}L${segStart},${y(lo)}Z`;
          return { d, area };
        });
        const hoverT = hover !== null ? from + ((hover - padL) / plotW) * (to - from) : null;
        const hoverVals =
          hoverT !== null
            ? series.map((s) => {
                let best: TimeValue | null = null;
                if (s.kind === "step") {
                  for (const p of s.points) if (p.timestamp <= hoverT) best = p;
                  return best && hoverT <= (s.points[s.points.length - 1]?.timestamp ?? 0) + 60 ? { timestamp: hoverT, value: best.value } : null;
                }
                for (const p of s.points) if (!best || Math.abs(p.timestamp - hoverT) < Math.abs(best.timestamp - hoverT)) best = p;
                return best && Math.abs(best.timestamp - hoverT) < (to - from) / 40 ? best : null;
              })
            : [];
        return (
          <g
            onPointerMove={(e) => setHover(e.nativeEvent.offsetX)}
            onPointerDown={(e) => setHover(e.nativeEvent.offsetX)}
            onPointerLeave={() => setHover(null)}
          >
            <rect x={0} y={0} width={w} height={height} fill="transparent" />
            {bands.map((b, i) => (
              <rect key={i} x={x(Math.max(b.start, from))} y={padT} width={Math.max(0, x(Math.min(b.end, to)) - x(Math.max(b.start, from)))} height={plotH} fill={b.color} />
            ))}
            {[lo, (lo + hi) / 2, hi].map((t) => (
              <g key={t}>
                <line x1={padL} x2={w} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" />
                <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
                  {format(t)}
                </text>
              </g>
            ))}
            {refLines.map((r) => (
              <g key={r.value + (r.label ?? "")}>
                <line x1={padL} x2={w} y1={y(r.value)} y2={y(r.value)} stroke={r.color} strokeDasharray="5 4" strokeWidth={1.25} />
                {r.label && (
                  <text x={padL + 4} y={y(r.value) - 4} className="text-[10px] font-medium" fill={r.color}>
                    {r.label}
                  </text>
                )}
              </g>
            ))}
            {ticks.map((t) => (
              <text key={t} x={x(t)} y={height - 4} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                {xTicks === "hours" ? (w > 480 ? fmtTime(t) : `${new Date(t * 1000).getHours()}`) : new Date(t * 1000).getDate()}
              </text>
            ))}
            {series.map((s, i) =>
              s.kind === "bars" ? (
                <g key={i}>
                  {s.points.map((p, k) => {
                    const next = s.points[k + 1];
                    const span = Math.min(next ? next.timestamp - p.timestamp : 180, s.gap ?? 300);
                    const bw = Math.max(1, x(p.timestamp + span) - x(p.timestamp) - 0.5);
                    return <rect key={p.timestamp} x={x(p.timestamp)} y={y(p.value)} width={bw} height={Math.max(0, y(lo) - y(p.value))} fill={s.colorOf?.(p.value) ?? s.color} />;
                  })}
                </g>
              ) : (
              <g key={i}>
                {s.area && <path d={paths[i].area} fill={s.color} opacity={0.18} />}
                <path d={paths[i].d} fill="none" stroke={s.color} strokeWidth={s.width ?? 1.75} strokeLinejoin="round" strokeLinecap="round" />
                {s.dots && s.points.map((p) => <circle key={p.timestamp} cx={x(p.timestamp)} cy={y(p.value)} r={2.5} fill={s.color} />)}
              </g>
              ),
            )}
            {hoverT !== null && hoverVals.some(Boolean) && (
              <g pointerEvents="none">
                <line x1={hover!} x2={hover!} y1={padT} y2={padT + plotH} stroke="var(--muted-foreground)" strokeOpacity={0.5} />
                {hoverVals.map((p, i) => p && <circle key={i} cx={x(p.timestamp)} cy={y(p.value)} r={4} fill={series[i].color} stroke="var(--card)" strokeWidth={2} />)}
                <g transform={`translate(${Math.min(Math.max(hover! - 50, padL), w - 104)},${padT})`}>
                  <rect width={104} height={18 + 14 * hoverVals.filter(Boolean).length} rx={6} fill="var(--popover)" stroke="var(--border)" />
                  <text x={8} y={13} className="fill-muted-foreground text-[10px]">
                    {xTicks === "hours" ? fmtTime(hoverVals.find(Boolean)!.timestamp) : new Date(hoverVals.find(Boolean)!.timestamp * 1000).toLocaleDateString("it-IT", { day: "numeric", month: "short" })}
                  </text>
                  {hoverVals.filter(Boolean).map((p, i) => (
                    <text key={i} x={8} y={27 + i * 14} className="fill-foreground text-[11px] font-semibold">
                      {format(p!.value)} {series[hoverVals.indexOf(p)].label ?? ""}
                    </text>
                  ))}
                </g>
              </g>
            )}
          </g>
        );
      }}
    </Frame>
  );
}

// ---------------------------------------------------------------- sleep hypnogram

const STAGE_ROW: Record<number, number> = { 1: 0, 4: 1, 2: 2, 3: 3 };

export interface Overlay {
  points: TimeValue[];
  color: string;
  label: string;
  unit: string;
}

/** Sleep stages in rows (Sveglio, REM, Leggero, Profondo) with an optional line on top (heart rate, SpO2, breathing). */
export function Hypnogram({ segments, from, to, height = 170, overlay }: { segments: SleepSegment[]; from: number; to: number; height?: number; overlay?: Overlay | null }) {
  const padL = 62;
  const padR = overlay ? 34 : 4;
  const padB = 20;
  const vals = overlay?.points.map((p) => p.value) ?? [];
  const oLo = vals.length ? niceFloor(Math.min(...vals) * 0.95) : 0;
  const oHi = vals.length ? niceCeil(Math.max(...vals) * 1.05) : 1;
  return (
    <Frame height={height}>
      {(w) => {
        const plotW = w - padL - padR;
        const plotH = height - padB;
        const rowH = plotH / 4;
        const x = (t: number) => padL + ((t - from) / (to - from || 1)) * plotW;
        const yO = (v: number) => 4 + (plotH - 8) - ((v - oLo) / (oHi - oLo || 1)) * (plotH - 8);
        const hours: number[] = [];
        const d = new Date(from * 1000);
        d.setMinutes(0, 0, 0);
        for (let t = d.getTime() / 1000 + 3600; t < to; t += 3600) hours.push(t);
        let path = "";
        let prev: number | null = null;
        for (const p of overlay?.points ?? []) {
          path += `${prev === null || p.timestamp - prev > 900 ? "M" : "L"}${x(p.timestamp).toFixed(1)},${yO(p.value).toFixed(1)}`;
          prev = p.timestamp;
        }
        return (
          <g>
            {[1, 4, 2, 3].map((st) => (
              <g key={st}>
                <rect x={padL} y={STAGE_ROW[st] * rowH} width={plotW} height={rowH} fill={st % 2 ? "transparent" : "var(--chart-grid)"} opacity={0.5} />
                <text x={padL - 8} y={STAGE_ROW[st] * rowH + rowH / 2 + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
                  {STAGE_LABEL[st]}
                </text>
              </g>
            ))}
            {segments.map((s, i) => (
              <rect
                key={i}
                x={x(s.start)}
                y={STAGE_ROW[s.stage] * rowH + 3}
                width={Math.max(1, x(s.end) - x(s.start))}
                height={rowH - 6}
                rx={2}
                fill={STAGE_COLOR[s.stage]}
                opacity={overlay ? 0.75 : 1}
              >
                <title>{`${STAGE_LABEL[s.stage]} ${fmtTime(s.start)}–${fmtTime(s.end)}`}</title>
              </rect>
            ))}
            {overlay && (
              <g>
                <path d={path} fill="none" stroke={overlay.color} strokeWidth={1.5} strokeLinejoin="round" />
                {[oLo, oHi].map((v) => (
                  <text key={v} x={w - 2} y={yO(v) + 4} textAnchor="end" className="text-[10px]" fill={overlay.color}>
                    {Math.round(v)}
                  </text>
                ))}
              </g>
            )}
            {hours
              .filter((_, i) => hours.length < 10 || i % 2 === 0)
              .map((t) => (
                <text key={t} x={x(t)} y={height - 4} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {w > 480 ? fmtTime(t) : new Date(t * 1000).getHours()}
                </text>
              ))}
          </g>
        );
      }}
    </Frame>
  );
}

// ---------------------------------------------------------------- 24h activity & sleep

export interface MinuteSlot {
  t: number;
  /** "activity" intensity 0..1 */
  level: number;
  color: string;
}

export function ActivitySleepChart({ slots, hr, from, to, height = 190 }: { slots: MinuteSlot[]; hr: TimeValue[]; from: number; to: number; height?: number }) {
  const padL = 30;
  const padR = 30;
  const padB = 20;
  const hrMax = Math.max(120, ...hr.map((h) => h.value));
  const hrMin = 40;
  return (
    <Frame height={height}>
      {(w) => {
        const plotW = w - padL - padR;
        const plotH = height - padB - 6;
        const x = (t: number) => padL + ((t - from) / (to - from)) * plotW;
        const slotW = Math.max(1, plotW / ((to - from) / 300));
        const yHr = (v: number) => 6 + plotH - ((v - hrMin) / (hrMax - hrMin)) * plotH;
        let d = "";
        let prev: number | null = null;
        for (const p of hr) {
          d += `${prev === null || p.timestamp - prev > 1800 ? "M" : "L"}${x(p.timestamp)},${yHr(p.value)}`;
          prev = p.timestamp;
        }
        return (
          <g>
            {[0, 0.5, 1].map((f) => (
              <line key={f} x1={padL} x2={padL + plotW} y1={6 + plotH * f} y2={6 + plotH * f} stroke="var(--chart-grid)" />
            ))}
            {slots.map((s) => (
              <rect key={s.t} x={x(s.t)} y={6 + plotH * (1 - s.level)} width={slotW + 0.3} height={plotH * s.level} fill={s.color} />
            ))}
            <path d={d} fill="none" stroke="var(--heart)" strokeWidth={1.4} strokeLinejoin="round" />
            {[hrMin, Math.round((hrMin + hrMax) / 2), hrMax].map((v) => (
              <text key={v} x={padL + plotW + 4} y={yHr(v) + 4} className="fill-heart text-[10px]">
                {v}
              </text>
            ))}
            {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => {
              const t = from + h * 3600;
              return (
                <text key={h} x={x(t)} y={height - 4} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {h}
                </text>
              );
            })}
          </g>
        );
      }}
    </Frame>
  );
}

// ---------------------------------------------------------------- rings

export function DayRing({ slots, size = 180, children }: { slots: { color: string }[]; size?: number; children?: ReactNode }) {
  const r = size / 2 - 12;
  const c = size / 2;
  const n = slots.length || 96;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--muted)" strokeWidth={14} />
        {slots.map((s, i) => {
          const a0 = (i / n) * Math.PI * 2 - Math.PI / 2;
          const a1 = ((i + 1) / n) * Math.PI * 2 - Math.PI / 2;
          return (
            <path
              key={i}
              d={`M${c + r * Math.cos(a0)},${c + r * Math.sin(a0)} A${r},${r} 0 0 1 ${c + r * Math.cos(a1)},${c + r * Math.sin(a1)}`}
              stroke={s.color}
              strokeWidth={14}
              fill="none"
            />
          );
        })}
        {[0, 6, 12, 18].map((h) => {
          const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
          return (
            <text key={h} x={c + (r - 20) * Math.cos(a)} y={c + (r - 20) * Math.sin(a) + 4} textAnchor="middle" className="fill-muted-foreground text-[10px]">
              {h}
            </text>
          );
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

/** Ring split into proportional colored arcs (sleep stages, stress levels, calorie split). */
export function SegmentRing({ segments, size = 190, stroke = 14, children }: { segments: { value: number; color: string; label?: string }[]; size?: number; stroke?: number; children?: ReactNode }) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const gap = segments.filter((x) => x.value > 0).length > 1 ? 3 : 0;
  let acc = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
        {total > 0 &&
          segments.map((x, i) => {
            if (x.value <= 0) return null;
            const len = (x.value / total) * circ;
            const el = (
              <circle
                key={i}
                cx={c}
                cy={c}
                r={r}
                fill="none"
                stroke={x.color}
                strokeWidth={stroke}
                strokeDasharray={`${Math.max(0.5, len - gap)} ${circ}`}
                strokeDashoffset={-acc}
              >
                {x.label && <title>{x.label}</title>}
              </circle>
            );
            acc += len;
            return el;
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

/** 3/4 arc gauge, 0..max (Body Battery). */
export function ArcGauge({ value, max = 100, color, size = 190, stroke = 14, children }: { value: number | null; max?: number; color: string; size?: number; stroke?: number; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const arc = circ * 0.75;
  const p = value == null ? 0 : Math.min(1, Math.max(0, value / max));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(135deg)" }}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} strokeDasharray={`${arc} ${circ}`} strokeLinecap="round" />
        {p > 0 && <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={`${arc * p} ${circ}`} strokeLinecap="round" />}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

export function GoalRing({ value, goal, color, size = 64, stroke = 7, children }: { value: number; goal: number; color: string; size?: number; stroke?: number; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const p = Math.min(1, goal > 0 ? value / goal : 0);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={`${circ * p} ${circ}`} strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: i.color }} />
          <span className="text-muted-foreground">{i.label}</span>
          {i.value && <span className="font-medium tabular">{i.value}</span>}
        </div>
      ))}
    </div>
  );
}
