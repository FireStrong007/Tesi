/**
 * Lightweight SVG charts in the spirit of Gadgetbridge's activity charts:
 * bar chart with goal line, time-series line/area chart, sleep hypnogram,
 * the 24 h "activity & sleep" chart, the dashboard 24 h ring and goal rings.
 *
 * Interaction (scrub tooltip, pinch/wheel zoom of the time axis) lives in
 * ./interaction.ts. Each chart renders its axes and data as memoized layers,
 * so moving the finger only re-renders the cursor and the tooltip.
 */
import { useId, useMemo, type ReactNode, type RefObject } from "react";
import { RotateCcwIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSize } from "@/hooks/use-size";
import { cn } from "@/lib/utils";
import { fmt1, fmtInt, fmtTime } from "@/lib/format";
import type { SleepSegment, TimeValue } from "@/lib/db/repo";
import { nearestPoint, pointAtOrBefore, useChartInteraction, visibleSlice, type ChartInteraction, type TimeWindow } from "./interaction";

import { STAGE_COLOR, STAGE_LABEL } from "@/lib/colors";
export { STAGE_COLOR, STAGE_LABEL };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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

const fmtShortDate = (t: number) => new Date(t * 1000).toLocaleDateString("it-IT", { day: "numeric", month: "short" });
const hoursLabel = (w: TimeWindow) => `${fmtTime(w.from)}–${fmtTime(w.to)}`;

/** SVG ids may not contain the characters React puts in useId() */
const useClipId = () => "clip" + useId().replace(/[^a-zA-Z0-9_-]/g, "");

// ---------------------------------------------------------------- shared pieces

/** Chart container: receives the gestures and shows the zoom bar while zoomed. */
function Surface({
  boxRef,
  ix,
  width,
  height,
  rangeLabel,
  cursor,
  children,
}: {
  boxRef: RefObject<HTMLDivElement | null>;
  ix: ChartInteraction;
  width: number;
  height: number;
  rangeLabel?: (w: TimeWindow) => string;
  cursor?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        ref={boxRef}
        {...ix.handlers}
        className={cn("relative w-full select-none", ix.panning ? "cursor-grabbing" : ix.zoomed ? "cursor-grab" : cursor)}
        // pan-y: vertical drags still scroll the page, horizontal drags and pinches come to the chart
        style={{ height, touchAction: "pan-y", WebkitTapHighlightColor: "transparent" }}
      >
        {width > 0 && (
          <svg width={width} height={height} className="absolute inset-0 overflow-visible" role="img">
            {children}
          </svg>
        )}
      </div>
      {ix.zoomed && rangeLabel && <ZoomBar ix={ix} label={rangeLabel(ix.view)} />}
    </div>
  );
}

function ZoomBar({ ix, label }: { ix: ChartInteraction; label: string }) {
  return (
    <div className="text-muted-foreground mt-1.5 flex items-center gap-1 text-xs">
      <span className="truncate tabular-nums">
        {label} · {ix.zoom < 10 ? fmt1(ix.zoom) : fmtInt(ix.zoom)}×
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <Button variant="ghost" size="icon" className="size-8" onClick={ix.zoomOut} aria-label="Riduci zoom">
          <ZoomOutIcon />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={ix.zoomIn} aria-label="Aumenta zoom">
          <ZoomInIcon />
        </Button>
        <Button variant="outline" size="sm" className="h-8" onClick={ix.reset}>
          <RotateCcwIcon />
          Tutto
        </Button>
      </div>
    </div>
  );
}

interface TipLine {
  text: string;
  color?: string;
}

/** Tooltip placed beside the cursor, on the side with more room, so a finger never covers it. */
function Tooltip({ x, width, plotLeft, top, title, lines }: { x: number; width: number; plotLeft: number; top: number; title: string; lines: TipLine[] }) {
  const chars = Math.max(title.length, ...lines.map((l) => l.text.length + (l.color ? 2 : 0)));
  const tw = Math.ceil(16 + chars * 6.2);
  const th = 20 + 14 * lines.length;
  const left = Math.max(0, Math.min(x > (plotLeft + width) / 2 ? x - tw - 10 : x + 10, width - tw));
  return (
    <g pointerEvents="none" transform={`translate(${left},${top})`}>
      <rect width={tw} height={th} rx={6} fill="var(--popover)" stroke="var(--border)" />
      <text x={8} y={14} className="fill-muted-foreground text-[10px]">
        {title}
      </text>
      {lines.map((l, i) => (
        <g key={i}>
          {l.color && <circle cx={11} cy={24 + i * 14} r={3} fill={l.color} />}
          <text x={l.color ? 18 : 8} y={28 + i * 14} className="fill-foreground text-[11px] font-semibold">
            {l.text}
          </text>
        </g>
      ))}
    </g>
  );
}

function Cursor({ x, top, bottom }: { x: number; top: number; bottom: number }) {
  return <line x1={x} x2={x} y1={top} y2={bottom} stroke="var(--muted-foreground)" strokeOpacity={0.6} pointerEvents="none" />;
}

const HOUR_STEPS = [300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/** hour ticks aligned to local time, as many as fit in the plot width */
function hourTicks(from: number, to: number, plotW: number, wide: boolean) {
  const maxLabels = Math.max(2, Math.floor(plotW / (wide ? 64 : 40)));
  const step = HOUR_STEPS.find((s) => (to - from) / s <= maxLabels) ?? 86400;
  const d = new Date(from * 1000);
  d.setMinutes(0, 0, 0);
  const ticks: number[] = [];
  const start = d.getTime() / 1000;
  if (step < 3600) {
    for (let t = start; t <= to; t += step) if (t >= from) ticks.push(t);
  } else {
    for (let t = start; t <= to; t += 3600) if (t >= from && new Date(t * 1000).getHours() % (step / 3600) === 0) ticks.push(t);
  }
  const label = (t: number) => (step < 3600 || wide ? fmtTime(t) : String(new Date(t * 1000).getHours()));
  return { ticks, label };
}

/** one tick per day of [from, to], thinned out to fit; only those inside the view */
function dayTicks(from: number, to: number, view: TimeWindow, plotW: number) {
  const maxLabels = Math.max(2, Math.floor(plotW / 26));
  const n = (view.to - view.from) / 86400;
  const k = [1, 2, 3, 5, 7, 14].find((k) => n / k <= maxLabels) ?? 14;
  const ticks: number[] = [];
  for (let i = 0, t = from; t <= to; i++, t = from + i * 86400) if (i % k === 0 && t >= view.from - 1 && t <= view.to + 1) ticks.push(t);
  return ticks;
}

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
  const [ref, { width: w }] = useSize<HTMLDivElement>();
  const padL = 40;
  const padB = 22;
  const padT = 8;
  const plotW = Math.max(1, w - padL);
  const plotH = height - padB - padT;
  const bw = plotW / Math.max(items.length, 1);
  const indexAt = (px: number) => {
    const i = Math.floor((px - padL) / bw);
    return i >= 0 && i < items.length ? i : null;
  };
  const ix = useChartInteraction({
    ref,
    from: 0,
    to: items.length,
    plotLeft: padL,
    plotWidth: plotW,
    onTap: (px) => {
      const i = indexAt(px);
      if (i !== null) onSelect?.(items[i].key);
    },
  });

  const top = Math.max(goal ?? 0, ...refLines.map((r) => r.value), ...items.map((i) => Math.max(i.value, i.marker ?? 0)));
  const max = yMax ?? niceMax(top * 1.08);
  const min = yMin ?? 0;
  const y = (v: number) => padT + plotH - ((Math.max(min, v) - min) / (max - min || 1)) * plotH;
  const vf = valueFormat ?? format;

  const grid = useMemo(
    () =>
      w > 0 &&
      [min, (min + max) / 2, max].map((t) => (
        <g key={t}>
          <line x1={padL} x2={w} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" />
          <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
            {format(t)}
          </text>
        </g>
      )),
    [w, min, max, plotH, format], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const bars = useMemo(
    () =>
      w > 0 && (
        <g>
          {items.map((it, i) => {
            const x = padL + i * bw + bw * 0.15;
            const bwi = bw * 0.7;
            const isSel = selected === it.key;
            let acc = 0;
            return (
              <g key={it.key}>
                {isSel && <rect x={padL + i * bw} y={padT} width={bw} height={plotH} fill="var(--accent)" rx={4} />}
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
        </g>
      ),
    [items, w, min, max, plotH, height, selected, showValues, labelEvery, goal, refLines, color, vf], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const hover = ix.hoverX !== null ? indexAt(ix.hoverX) : null;
  const hit = hover !== null ? items[hover] : null;
  return (
    <Surface boxRef={ref} ix={ix} width={w} height={height} cursor={onSelect ? "cursor-pointer" : undefined}>
      {grid}
      {hover !== null && <rect x={padL + hover * bw} y={padT} width={bw} height={plotH} fill="color-mix(in oklch, var(--accent) 60%, transparent)" rx={4} pointerEvents="none" />}
      {bars}
      {hit && (
        <Tooltip
          x={padL + hover! * bw + bw / 2}
          width={w}
          plotLeft={padL}
          top={padT}
          title={hit.label}
          lines={[{ text: hit.base !== undefined ? `${vf(hit.base)} – ${vf(hit.value)}` : vf(hit.value) }]}
        />
      )}
    </Surface>
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

function seriesPaths(s: Series, pts: TimeValue[], x: (t: number) => number, y: (v: number) => number, base: number) {
  let d = "";
  let area = "";
  let segStart: number | null = null;
  let prev: TimeValue | null = null;
  const P = (t: number, v: number) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`;
  for (const p of pts) {
    const brk = !prev || (s.gap !== undefined && p.timestamp - prev.timestamp > s.gap);
    if (s.kind === "step" && prev && !brk) {
      d += `L${P(p.timestamp, prev.value)}`;
      if (s.area) area += `L${P(p.timestamp, prev.value)}`;
    }
    if (brk) {
      if (prev && segStart !== null && s.area) area += `L${P(prev.timestamp, base)}L${segStart.toFixed(1)},${y(base).toFixed(1)}Z`;
      d += `M${P(p.timestamp, p.value)}`;
      segStart = x(p.timestamp);
    } else d += `L${P(p.timestamp, p.value)}`;
    if (s.area) area += `${brk ? "M" : "L"}${P(p.timestamp, p.value)}`;
    prev = p;
  }
  if (s.area && prev && segStart !== null) area += `L${P(prev.timestamp, base)}L${segStart.toFixed(1)},${y(base).toFixed(1)}Z`;
  return { d, area };
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
  const [ref, { width: w }] = useSize<HTMLDivElement>();
  const padL = 36;
  const padR = 4;
  const padB = 20;
  const padT = 8;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = height - padB - padT;
  // a month of daily points: zoom down to ~3 days at most
  const maxZoom = xTicks === "days" ? Math.max(1, (to - from) / (3 * 86400)) : 32;
  const ix = useChartInteraction({ ref, from, to, plotLeft: padL, plotWidth: plotW, zoomable: maxZoom > 1.5, maxZoom });
  const { from: vf, to: vt } = ix.view;
  const clip = useClipId();

  const [lo, hi] = useMemo(() => {
    let mn = Infinity;
    let mx = -Infinity;
    for (const s of series)
      for (const p of s.points) {
        if (p.value < mn) mn = p.value;
        if (p.value > mx) mx = p.value;
      }
    const has = mn <= mx;
    return [yMin ?? (has ? niceFloor(mn * 0.95) : 0), yMax ?? (has ? niceCeil(mx * 1.05) : 100)];
  }, [series, yMin, yMax]);

  const x = (t: number) => padL + ((t - vf) / (vt - vf || 1)) * plotW;
  const y = (v: number) => padT + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  const background = useMemo(
    () =>
      w > 0 && (
        <g clipPath={`url(#${clip})`}>
          {bands.map((b, i) => (
            <rect key={i} x={x(Math.max(b.start, vf))} y={padT} width={Math.max(0, x(Math.min(b.end, vt)) - x(Math.max(b.start, vf)))} height={plotH} fill={b.color} />
          ))}
        </g>
      ),
    [bands, w, vf, vt, plotH, clip], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const axes = useMemo(() => {
    if (!w) return null;
    const hours = xTicks === "hours" ? hourTicks(vf, vt, plotW, w > 480) : null;
    const ticks = hours ? hours.ticks : dayTicks(from, to, { from: vf, to: vt }, plotW);
    return (
      <g>
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
            {hours ? hours.label(t) : new Date(t * 1000).getDate()}
          </text>
        ))}
      </g>
    );
  }, [w, vf, vt, from, to, lo, hi, plotH, height, xTicks, refLines, format]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = useMemo(() => {
    if (!w) return null;
    return (
      <g clipPath={`url(#${clip})`}>
        {series.map((s, i) => {
          const pts = visibleSlice(s.points, vf, vt);
          if (s.kind === "bars")
            return (
              <g key={i}>
                {pts.map((p, k) => {
                  const next = pts[k + 1];
                  const span = Math.min(next ? next.timestamp - p.timestamp : 180, s.gap ?? 300);
                  const bw = Math.max(1, x(p.timestamp + span) - x(p.timestamp) - 0.5);
                  return <rect key={p.timestamp} x={x(p.timestamp)} y={y(p.value)} width={bw} height={Math.max(0, y(lo) - y(p.value))} fill={s.colorOf?.(p.value) ?? s.color} />;
                })}
              </g>
            );
          const { d, area } = seriesPaths(s, pts, x, y, lo);
          return (
            <g key={i}>
              {s.area && <path d={area} fill={s.color} opacity={0.18} />}
              <path d={d} fill="none" stroke={s.color} strokeWidth={s.width ?? 1.75} strokeLinejoin="round" strokeLinecap="round" />
              {s.dots && pts.map((p) => <circle key={p.timestamp} cx={x(p.timestamp)} cy={y(p.value)} r={2.5} fill={s.color} />)}
            </g>
          );
        })}
      </g>
    );
  }, [series, w, vf, vt, lo, hi, plotH, clip]); // eslint-disable-line react-hooks/exhaustive-deps

  let hover: ReactNode = null;
  if (ix.hoverX !== null && w > 0) {
    const t = vf + ((clamp(ix.hoverX, padL, padL + plotW) - padL) / plotW) * (vt - vf);
    const tol = (vt - vf) / 40;
    const vals = series.map((s) => {
      if (s.kind === "step") {
        const p = pointAtOrBefore(s.points, t);
        const last = s.points[s.points.length - 1];
        return p && t <= last.timestamp + 60 ? { timestamp: t, value: p.value } : null;
      }
      const p = nearestPoint(s.points, t);
      return p && Math.abs(p.timestamp - t) < tol ? p : null;
    });
    const first = vals.find((v) => v !== null);
    if (first) {
      const lx = x(first.timestamp);
      const many = vals.filter(Boolean).length > 1;
      hover = (
        <g pointerEvents="none">
          <Cursor x={lx} top={padT} bottom={padT + plotH} />
          {vals.map((p, i) => p && <circle key={i} cx={x(p.timestamp)} cy={y(p.value)} r={4} fill={series[i].colorOf?.(p.value) ?? series[i].color} stroke="var(--card)" strokeWidth={2} />)}
          <Tooltip
            x={lx}
            width={w}
            plotLeft={padL}
            top={padT}
            title={xTicks === "hours" ? fmtTime(first.timestamp) : fmtShortDate(first.timestamp)}
            lines={vals.flatMap((p, i) => (p ? [{ text: `${format(p.value)} ${series[i].label ?? ""}`.trim(), color: many ? series[i].color : undefined }] : []))}
          />
        </g>
      );
    }
  }

  return (
    <Surface boxRef={ref} ix={ix} width={w} height={height} rangeLabel={xTicks === "hours" ? hoursLabel : (v) => `${fmtShortDate(v.from)} – ${fmtShortDate(v.to)}`}>
      <defs>
        <clipPath id={clip}>
          <rect x={padL} y={0} width={plotW} height={height} />
        </clipPath>
      </defs>
      {background}
      {axes}
      {data}
      {hover}
    </Surface>
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
  const [ref, { width: w }] = useSize<HTMLDivElement>();
  const padL = 62;
  const padR = overlay ? 34 : 4;
  const padB = 20;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = height - padB;
  const rowH = plotH / 4;
  const ix = useChartInteraction({ ref, from, to, plotLeft: padL, plotWidth: plotW, zoomable: true });
  const { from: vf, to: vt } = ix.view;
  const clip = useClipId();

  const [oLo, oHi] = useMemo(() => {
    let mn = Infinity;
    let mx = -Infinity;
    for (const p of overlay?.points ?? []) {
      if (p.value < mn) mn = p.value;
      if (p.value > mx) mx = p.value;
    }
    return mn <= mx ? [niceFloor(mn * 0.95), niceCeil(mx * 1.05)] : [0, 1];
  }, [overlay]);

  const x = (t: number) => padL + ((t - vf) / (vt - vf || 1)) * plotW;
  const yO = (v: number) => 4 + (plotH - 8) - ((v - oLo) / (oHi - oLo || 1)) * (plotH - 8);

  const axes = useMemo(() => {
    if (!w) return null;
    const { ticks, label } = hourTicks(vf, vt, plotW, w > 480);
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
        {overlay &&
          [oLo, oHi].map((v) => (
            <text key={v} x={w - 2} y={yO(v) + 4} textAnchor="end" className="text-[10px]" fill={overlay.color}>
              {Math.round(v)}
            </text>
          ))}
        {ticks
          .filter((t) => x(t) >= padL + 10)
          .map((t) => (
            <text key={t} x={x(t)} y={height - 4} textAnchor="middle" className="fill-muted-foreground text-[10px]">
              {label(t)}
            </text>
          ))}
      </g>
    );
  }, [w, vf, vt, padR, height, overlay, oLo, oHi]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = useMemo(() => {
    if (!w) return null;
    let path = "";
    let prev: number | null = null;
    for (const p of visibleSlice(overlay?.points ?? [], vf, vt)) {
      path += `${prev === null || p.timestamp - prev > 900 ? "M" : "L"}${x(p.timestamp).toFixed(1)},${yO(p.value).toFixed(1)}`;
      prev = p.timestamp;
    }
    return (
      <g clipPath={`url(#${clip})`}>
        {segments
          .filter((s) => s.end >= vf && s.start <= vt)
          .map((s) => (
            <rect
              key={`${s.start}:${s.end}`}
              x={x(s.start)}
              y={STAGE_ROW[s.stage] * rowH + 3}
              width={Math.max(1, x(s.end) - x(s.start))}
              height={rowH - 6}
              rx={2}
              fill={STAGE_COLOR[s.stage]}
              opacity={overlay ? 0.75 : 1}
            />
          ))}
        {overlay && <path d={path} fill="none" stroke={overlay.color} strokeWidth={1.5} strokeLinejoin="round" />}
      </g>
    );
  }, [segments, overlay, w, vf, vt, padR, height, oLo, oHi, clip]); // eslint-disable-line react-hooks/exhaustive-deps

  let hover: ReactNode = null;
  if (ix.hoverX !== null && w > 0) {
    const hx = clamp(ix.hoverX, padL, padL + plotW);
    const t = vf + ((hx - padL) / plotW) * (vt - vf);
    const seg = segments.find((s) => t >= s.start && t < s.end);
    const near = overlay ? nearestPoint(overlay.points, t) : null;
    const ov = near && Math.abs(near.timestamp - t) <= 900 ? near : null;
    const lines: TipLine[] = [];
    if (seg) lines.push({ text: `${STAGE_LABEL[seg.stage]} ${fmtTime(seg.start)}–${fmtTime(seg.end)}`, color: STAGE_COLOR[seg.stage] });
    if (ov && overlay) lines.push({ text: `${fmt1(ov.value)} ${overlay.unit}`, color: overlay.color });
    if (lines.length)
      hover = (
        <g pointerEvents="none">
          <Cursor x={hx} top={0} bottom={plotH} />
          {ov && overlay && <circle cx={x(ov.timestamp)} cy={yO(ov.value)} r={4} fill={overlay.color} stroke="var(--card)" strokeWidth={2} />}
          <Tooltip x={hx} width={w} plotLeft={padL} top={2} title={fmtTime(t)} lines={lines} />
        </g>
      );
  }

  return (
    <Surface boxRef={ref} ix={ix} width={w} height={height} rangeLabel={hoursLabel}>
      <defs>
        <clipPath id={clip}>
          <rect x={padL} y={0} width={plotW} height={height} />
        </clipPath>
      </defs>
      {axes}
      {data}
      {hover}
    </Surface>
  );
}

// ---------------------------------------------------------------- 24h activity & sleep

export interface MinuteSlot {
  t: number;
  /** "activity" intensity 0..1 */
  level: number;
  color: string;
  /** shown in the tooltip */
  label?: string;
}

export function ActivitySleepChart({ slots, hr, from, to, height = 190 }: { slots: MinuteSlot[]; hr: TimeValue[]; from: number; to: number; height?: number }) {
  const [ref, { width: w }] = useSize<HTMLDivElement>();
  const padL = 30;
  const padR = 30;
  const padB = 20;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = height - padB - 6;
  const ix = useChartInteraction({ ref, from, to, plotLeft: padL, plotWidth: plotW, zoomable: true });
  const { from: vf, to: vt } = ix.view;
  const clip = useClipId();
  const hrMax = useMemo(() => hr.reduce((m, h) => Math.max(m, h.value), 120), [hr]);
  const hrMin = 40;

  const x = (t: number) => padL + ((t - vf) / (vt - vf || 1)) * plotW;
  const yHr = (v: number) => 6 + plotH - ((v - hrMin) / (hrMax - hrMin)) * plotH;

  const axes = useMemo(() => {
    if (!w) return null;
    const { ticks, label } = hourTicks(vf, vt, plotW, w > 480);
    return (
      <g>
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={padL} x2={padL + plotW} y1={6 + plotH * f} y2={6 + plotH * f} stroke="var(--chart-grid)" />
        ))}
        {[hrMin, Math.round((hrMin + hrMax) / 2), hrMax].map((v) => (
          <text key={v} x={padL + plotW + 4} y={yHr(v) + 4} className="fill-heart text-[10px]">
            {v}
          </text>
        ))}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={height - 4} textAnchor="middle" className="fill-muted-foreground text-[10px]">
            {label(t)}
          </text>
        ))}
      </g>
    );
  }, [w, vf, vt, height, hrMax]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = useMemo(() => {
    if (!w) return null;
    const slotW = Math.max(1, plotW / ((vt - vf) / 300));
    let d = "";
    let prev: number | null = null;
    for (const p of visibleSlice(hr, vf, vt)) {
      d += `${prev === null || p.timestamp - prev > 1800 ? "M" : "L"}${x(p.timestamp).toFixed(1)},${yHr(p.value).toFixed(1)}`;
      prev = p.timestamp;
    }
    return (
      <g clipPath={`url(#${clip})`}>
        {slots
          .filter((s) => s.t + 300 >= vf && s.t <= vt)
          .map((s) => (
            <rect key={s.t} x={x(s.t)} y={6 + plotH * (1 - s.level)} width={slotW + 0.3} height={plotH * s.level} fill={s.color} />
          ))}
        <path d={d} fill="none" stroke="var(--heart)" strokeWidth={1.4} strokeLinejoin="round" />
      </g>
    );
  }, [slots, hr, w, vf, vt, height, hrMax, clip]); // eslint-disable-line react-hooks/exhaustive-deps

  let hover: ReactNode = null;
  if (ix.hoverX !== null && w > 0) {
    const hx = clamp(ix.hoverX, padL, padL + plotW);
    const t = vf + ((hx - padL) / plotW) * (vt - vf);
    const slot = slots.find((s) => t >= s.t && t < s.t + 300);
    const near = nearestPoint(hr, t);
    const h = near && Math.abs(near.timestamp - t) <= 600 ? near : null;
    const lines: TipLine[] = [];
    if (slot?.label) lines.push({ text: slot.label, color: slot.color });
    if (h) lines.push({ text: `${fmtInt(h.value)} bpm`, color: "var(--heart)" });
    if (lines.length)
      hover = (
        <g pointerEvents="none">
          <Cursor x={hx} top={6} bottom={6 + plotH} />
          {h && <circle cx={x(h.timestamp)} cy={yHr(h.value)} r={4} fill="var(--heart)" stroke="var(--card)" strokeWidth={2} />}
          <Tooltip x={hx} width={w} plotLeft={padL} top={6} title={slot ? `${fmtTime(slot.t)}–${fmtTime(slot.t + 300)}` : fmtTime(t)} lines={lines} />
        </g>
      );
  }

  return (
    <Surface boxRef={ref} ix={ix} width={w} height={height} rangeLabel={hoursLabel}>
      <defs>
        <clipPath id={clip}>
          <rect x={padL} y={0} width={plotW} height={height} />
        </clipPath>
      </defs>
      {axes}
      {data}
      {hover}
    </Surface>
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
