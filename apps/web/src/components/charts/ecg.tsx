/**
 * ECG traces on the paper grid, drawn on a <canvas> (only the visible part). The grid keeps its size
 * on screen (1 mm = PX_PER_MM px) and the zoom is the paper speed, in the standard steps 12.5, 25,
 * 50 and 100 mm/s like on an electrocardiograph: at 25 mm/s a small square is 0.04 s and a large
 * one 0.2 s, at 50 mm/s 0.02 and 0.1 s. The vertical scale is in the device's units (core
 * gima/ecg.ts): 100 units per large square, at every speed.
 *
 * The gestures are the other charts' (interaction.ts):
 *  - touch: one finger sideways shows the reading (it stays after lifting the finger), vertical
 *    drags scroll the page (touch-action: pan-y), two fingers zoom and move, a double tap goes to
 *    50 mm/s there, the next one back to 25 mm/s;
 *  - mouse: hover shows the reading, dragging moves, Ctrl + wheel or a trackpad pinch zooms, the
 *    horizontal wheel moves, a double click zooms / goes back to 25 mm/s;
 *  - the strip under the trace shows the whole recording with the visible part: dragging or tapping
 *    it moves along the recording (on a phone too);
 *  - the bar under it, always shown: the speed and the visible seconds, −, + and «25 mm/s».
 * A pinch zooms smoothly and stops at the nearest step when the fingers are lifted.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { RotateCcwIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { ECG_CLIP, ECG_SAMPLE_RATE_HZ } from "@bridge/core/gima/ecg";
import { fmt1, fmtInt } from "@bridge/core/format";
import { Cursor, Tooltip } from "./charts";
import { Button } from "@/components/ui/button";
import { useSize } from "@/hooks/use-size";
import { cn } from "@/lib/utils";

/** the paper speeds (mm/s) and the standard one */
export const PAPER_SPEEDS = [12.5, 25, 50, 100] as const;
export const STANDARD_SPEED = 25;
/** one millimetre of paper on screen */
const PX_PER_MM = 4;
/** device units per mm: 100 per large square (5 mm) */
const UNITS_PER_MM = 20;
/** the trace's band: ±600 units, so that the ±500 clipping is visible with room around it */
const HALF_MM = 30;
const ANIM_MS = 260;
const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 320;

export const fmtSpeed = (s: number) => `${Number.isInteger(s) ? fmtInt(s) : fmt1(s)} mm/s`;

/** the page's colours, read when drawing (they follow the theme) */
const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** The trace from second t0 at `pxPerS` px per second, on the grid of `pxPerMm` px per mm. */
function drawTrace(canvas: HTMLCanvasElement, samples: Int32Array, opts: { pxPerMm: number; pxPerS: number; t0: number; width: number; height: number; grid: boolean; labels: boolean }) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(opts.width * dpr);
  canvas.height = Math.round(opts.height * dpr);
  canvas.style.width = `${opts.width}px`;
  canvas.style.height = `${opts.height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, opts.width, opts.height);
  const mm = opts.pxPerMm;
  const mid = opts.height / 2;
  // the paper, in px from the recording's start
  const x0 = opts.t0 * opts.pxPerS;
  const primary = cssVar("--primary", "#cf5539");
  if (opts.grid) {
    // small squares (1 mm) then large (5 mm), aligned with the recording's start
    for (const [step, alpha] of [
      [1, 0.12],
      [5, 0.3],
    ] as const) {
      ctx.strokeStyle = primary;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = step === 5 ? 1 : 0.5;
      ctx.beginPath();
      const first = Math.ceil(x0 / (step * mm)) * step * mm;
      for (let x = first; x <= x0 + opts.width; x += step * mm) {
        ctx.moveTo(Math.round(x - x0) + 0.5, 0);
        ctx.lineTo(Math.round(x - x0) + 0.5, opts.height);
      }
      for (let k = 0; mid + k * step * mm <= opts.height; k++)
        for (const y of k ? [mid + k * step * mm, mid - k * step * mm] : [mid]) {
          ctx.moveTo(0, Math.round(y) + 0.5);
          ctx.lineTo(opts.width, Math.round(y) + 0.5);
        }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  const pxPerSample = opts.pxPerS / ECG_SAMPLE_RATE_HZ;
  const y = (v: number) => mid - (v / UNITS_PER_MM) * mm;
  const i0 = Math.max(0, Math.floor(x0 / pxPerSample) - 1);
  const i1 = Math.min(samples.length - 1, Math.ceil((x0 + opts.width) / pxPerSample) + 1);
  ctx.strokeStyle = cssVar("--foreground", "#111");
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) {
    const x = i * pxPerSample - x0;
    if (i === i0) ctx.moveTo(x, y(samples[i]));
    else ctx.lineTo(x, y(samples[i]));
  }
  ctx.stroke();
  if (opts.labels) {
    // seconds along the bottom
    ctx.fillStyle = cssVar("--muted-foreground", "#666");
    ctx.font = "10px system-ui, sans-serif";
    const every = opts.pxPerS < 40 ? 2 : 1;
    for (let s = Math.ceil(opts.t0 / every) * every; (s - opts.t0) * opts.pxPerS <= opts.width; s += every) ctx.fillText(`${s} s`, (s - opts.t0) * opts.pxPerS + 3, opts.height - 4);
  }
}

/** The whole recording, small: min and max of each column, and the visible part highlighted. */
function drawOverview(canvas: HTMLCanvasElement, samples: Int32Array, opts: { width: number; height: number; from: number; to: number; duration: number }) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(opts.width * dpr);
  canvas.height = Math.round(opts.height * dpr);
  canvas.style.width = `${opts.width}px`;
  canvas.style.height = `${opts.height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, opts.width, opts.height);
  const mid = opts.height / 2;
  const scale = (opts.height / 2 - 3) / ECG_CLIP;
  ctx.strokeStyle = cssVar("--muted-foreground", "#888");
  ctx.lineWidth = 1;
  ctx.beginPath();
  const per = samples.length / opts.width;
  for (let x = 0; x < opts.width; x++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = Math.floor(x * per); i < Math.min(samples.length, Math.floor((x + 1) * per) + 1); i++) {
      lo = Math.min(lo, samples[i]);
      hi = Math.max(hi, samples[i]);
    }
    if (lo === Infinity) continue;
    ctx.moveTo(x + 0.5, mid - hi * scale);
    ctx.lineTo(x + 0.5, mid - lo * scale + 0.5);
  }
  ctx.stroke();
  const a = (opts.from / opts.duration) * opts.width;
  const b = (opts.to / opts.duration) * opts.width;
  const primary = cssVar("--primary", "#cf5539");
  ctx.fillStyle = primary;
  ctx.globalAlpha = 0.14;
  ctx.fillRect(a, 0, Math.max(2, b - a), opts.height);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = primary;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(a + 0.75, 0.75, Math.max(2, b - a) - 1.5, opts.height - 1.5);
}

/** Does the recording have samples at the clipping limit (peaks cut by the Gima app)? */
export const hasClipped = (samples: Int32Array) => samples.some((v) => Math.abs(v) >= ECG_CLIP);

/** the nearest paper speed (in ratio, not in difference: 37 mm/s is nearer 50 than 25) */
const nearestSpeed = (s: number) => PAPER_SPEEDS.reduce((best, v) => (Math.abs(Math.log(v / s)) < Math.abs(Math.log(best / s)) ? v : best), PAPER_SPEEDS[0] as number);

type Gesture =
  | { kind: "mouse"; x0: number; t0: number; moved: boolean }
  | { kind: "touch"; x0: number; y0: number; time: number; moved: boolean }
  | { kind: "pinch"; d0: number; speed0: number; anchor: number; mid: number }
  | { kind: "done" };

/** The whole trace: the paper, the strip of the whole recording and the speed bar. */
export function EcgTrace({ samples }: { samples: Int32Array }) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const strip = useRef<HTMLCanvasElement>(null);
  const [speed, setSpeed] = useState<number>(STANDARD_SPEED);
  const [t0, setT0] = useState(0);
  /** the reading under the pointer (x in the visible part), or null */
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [panning, setPanning] = useState(false);
  const [theme, setTheme] = useState(0);
  const duration = samples.length / ECG_SAMPLE_RATE_HZ;
  const height = 2 * HALF_MM * PX_PER_MM;
  const pxPerS = speed * PX_PER_MM;
  const span = width > 0 ? width / pxPerS : 0;

  // the latest values for the handlers and the animation
  const live = useRef({ speed, t0, width, duration });
  live.current = { speed, t0, width, duration };
  const clampT0 = (t: number, s: number) => {
    const sp = live.current.width / (s * PX_PER_MM);
    return Math.max(0, Math.min(t, Math.max(0, live.current.duration - sp)));
  };
  const setView = useCallback((s: number, t: number) => {
    setSpeed(s);
    setT0(clampT0(t, s));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** to `target` mm/s keeping the moment at x (px in the view) where it is, animated */
  const anim = useRef(0);
  const zoomTo = useCallback(
    (target: number, x?: number) => {
      cancelAnimationFrame(anim.current);
      const L = live.current;
      const at = x ?? L.width / 2;
      const anchor = L.t0 + at / (L.speed * PX_PER_MM);
      const s0 = L.speed;
      const start = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - start) / ANIM_MS);
        const e = 1 - Math.pow(1 - k, 3);
        const s = s0 * Math.pow(target / s0, e);
        setView(s, anchor - at / (s * PX_PER_MM));
        if (k < 1) anim.current = requestAnimationFrame(step);
      };
      anim.current = requestAnimationFrame(step);
    },
    [setView],
  );
  const stepZoom = (dir: 1 | -1, x?: number) => {
    const i = PAPER_SPEEDS.indexOf(nearestSpeed(live.current.speed) as (typeof PAPER_SPEEDS)[number]);
    const next = PAPER_SPEEDS[Math.max(0, Math.min(PAPER_SPEEDS.length - 1, i + dir))];
    if (next !== live.current.speed) zoomTo(next, x);
  };
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  // redraw when the theme changes (the grid and trace colours are the page's)
  useEffect(() => {
    const o = new MutationObserver(() => setTheme((t) => t + 1));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => o.disconnect();
  }, []);
  useEffect(() => {
    if (canvas.current && width > 0) drawTrace(canvas.current, samples, { pxPerMm: PX_PER_MM, pxPerS, t0, width, height, grid: true, labels: true });
  }, [samples, pxPerS, t0, width, height, theme]);
  useEffect(() => {
    if (strip.current && width > 0) drawOverview(strip.current, samples, { width, height: 36, from: t0, to: Math.min(duration, t0 + span), duration });
  }, [samples, t0, span, width, duration, theme]);

  // ---- gestures on the paper
  const box = useRef<HTMLDivElement>(null);
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ x: number; t: number } | null>(null);
  const relX = (e: { clientX: number }) => e.clientX - (box.current?.getBoundingClientRect().left ?? 0);
  const relY = (e: { clientY: number }) => e.clientY - (box.current?.getBoundingClientRect().top ?? 0);
  /** a double tap or click: to 50 mm/s there from the standard speed, otherwise back to it */
  const tap = (x: number) => {
    const now = performance.now();
    const prev = lastTap.current;
    if (prev && now - prev.t < DOUBLE_TAP_MS && Math.abs(prev.x - x) < 30) {
      lastTap.current = null;
      zoomTo(live.current.speed === STANDARD_SPEED ? 50 : STANDARD_SPEED, x);
      return;
    }
    lastTap.current = { x, t: now };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    cancelAnimationFrame(anim.current);
    const x = relX(e);
    pts.current.set(e.pointerId, { x, y: relY(e) });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    if (e.pointerType === "mouse") gesture.current = { kind: "mouse", x0: x, t0: live.current.t0, moved: false };
    else if (pts.current.size === 1) {
      gesture.current = { kind: "touch", x0: x, y0: relY(e), time: performance.now(), moved: false };
      setHoverX(x);
    } else if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      const mid = (a.x + b.x) / 2;
      gesture.current = { kind: "pinch", d0: Math.max(24, Math.abs(a.x - b.x)), speed0: live.current.speed, anchor: live.current.t0 + mid / (live.current.speed * PX_PER_MM), mid };
      setHoverX(null);
    } else gesture.current = { kind: "done" };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const x = relX(e);
    if (pts.current.has(e.pointerId)) pts.current.set(e.pointerId, { x, y: relY(e) });
    const g = gesture.current;
    if (!g) {
      if (e.pointerType === "mouse") setHoverX(x);
      return;
    }
    if (g.kind === "mouse") {
      const dx = x - g.x0;
      if (Math.abs(dx) > 3) g.moved = true;
      if (g.moved) {
        setPanning(true);
        setHoverX(null);
        setView(live.current.speed, g.t0 - dx / (live.current.speed * PX_PER_MM));
      } else setHoverX(x);
    } else if (g.kind === "touch") {
      if (Math.abs(x - g.x0) > TAP_SLOP || Math.abs(relY(e) - g.y0) > TAP_SLOP) g.moved = true;
      setHoverX(x);
    } else if (g.kind === "pinch" && pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()];
      const d = Math.max(24, Math.abs(a.x - b.x));
      g.mid = (a.x + b.x) / 2;
      const s = Math.max(PAPER_SPEEDS[0], Math.min(PAPER_SPEEDS[PAPER_SPEEDS.length - 1], (g.speed0 * d) / g.d0));
      setView(s, g.anchor - g.mid / (s * PX_PER_MM));
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const x = relX(e);
    pts.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === "mouse") {
      gesture.current = null;
      setPanning(false);
      if (!g.moved) tap(x);
      return;
    }
    if (g?.kind === "touch" && !g.moved && performance.now() - g.time < 500) tap(x);
    // the pinch stops at the nearest paper speed, around the fingers
    if (g?.kind === "pinch") zoomTo(nearestSpeed(live.current.speed), g.mid);
    gesture.current = pts.current.size ? { kind: "done" } : null;
  };
  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    // the browser took over (a vertical page scroll)
    pts.current.delete(e.pointerId);
    gesture.current = pts.current.size ? { kind: "done" } : null;
    setPanning(false);
    setHoverX(null);
  };
  const onPointerLeave = (e: ReactPointerEvent<HTMLDivElement>) => {
    // touch readings stay after lifting the finger, so they can be read
    if (e.pointerType === "mouse" && gesture.current?.kind !== "mouse") setHoverX(null);
  };
  // tapping anywhere else hides a reading left by a finger
  const hovering = hoverX !== null;
  useEffect(() => {
    if (!hovering) return;
    const onDown = (ev: PointerEvent) => {
      if (box.current && !box.current.contains(ev.target as Node)) setHoverX(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [hovering]);
  // Ctrl + wheel or a trackpad pinch: one step per notch (or per enough pinching); the horizontal
  // wheel moves; the plain wheel scrolls the page
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      const x = e.clientX - el.getBoundingClientRect().left;
      if (e.ctrlKey) {
        e.preventDefault();
        acc += e.deltaMode !== 0 ? Math.sign(e.deltaY) * 100 : e.deltaY;
        if (Math.abs(acc) >= 40) {
          stepZoom(acc < 0 ? 1 : -1, x);
          acc = 0;
        }
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        e.preventDefault();
        cancelAnimationFrame(anim.current);
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        setView(live.current.speed, live.current.t0 + d / (live.current.speed * PX_PER_MM));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [width > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the strip: drag or tap to move along the recording
  const stripDrag = useRef<number | null>(null);
  const moveTo = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - r.left) / Math.max(1, r.width)) * live.current.duration;
    setView(live.current.speed, t - live.current.width / (live.current.speed * PX_PER_MM) / 2);
  };

  const visibleTo = Math.min(duration, t0 + span);
  return (
    <div ref={ref} className="space-y-2">
      <div
        ref={box}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        className={cn("relative overflow-hidden rounded-lg border select-none", panning ? "cursor-grabbing" : "cursor-grab")}
        // pan-y: vertical drags still scroll the page; sideways drags and pinches come to the trace
        style={{ height, touchAction: "pan-y", WebkitTapHighlightColor: "transparent" }}
        role="img"
        aria-label={`Tracciato ECG di ${Math.round(duration)} secondi a ${fmtSpeed(speed)}`}
      >
        <canvas ref={canvas} className="block" />
        {hoverX != null && width > 0 && <Reading samples={samples} x={hoverX} t0={t0} pxPerS={pxPerS} width={width} height={height} />}
      </div>
      <canvas
        ref={strip}
        className="block cursor-pointer rounded-md border"
        style={{ touchAction: "pan-y" }}
        aria-label="Tutta la registrazione: trascina o tocca per spostarti"
        onPointerDown={(e) => {
          stripDrag.current = e.pointerId;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* pointer already gone */
          }
          cancelAnimationFrame(anim.current);
          moveTo(e);
        }}
        onPointerMove={(e) => stripDrag.current === e.pointerId && moveTo(e)}
        onPointerUp={() => (stripDrag.current = null)}
        onPointerCancel={() => (stripDrag.current = null)}
      />
      <div className="text-muted-foreground flex items-center gap-1 text-xs">
        <span className="truncate tabular-nums">
          <span className="text-foreground font-medium">{fmtSpeed(speed)}</span> · {fmt1(t0)}–{fmt1(visibleTo)} s
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => stepZoom(-1)} disabled={speed <= PAPER_SPEEDS[0]} aria-label="Riduci zoom">
            <ZoomOutIcon />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => stepZoom(1)} disabled={speed >= PAPER_SPEEDS[PAPER_SPEEDS.length - 1]} aria-label="Aumenta zoom">
            <ZoomInIcon />
          </Button>
          <Button variant="outline" size="sm" className="h-8" onClick={() => zoomTo(STANDARD_SPEED)} disabled={speed === STANDARD_SPEED} aria-label="Torna a 25 mm/s">
            <RotateCcwIcon />
            25 mm/s
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The vertical line, the sample's point and «12,4 s · 230 unità», in the style of the other charts' tooltips. */
function Reading({ samples, x, t0, pxPerS, width, height }: { samples: Int32Array; x: number; t0: number; pxPerS: number; width: number; height: number }) {
  const i = Math.max(0, Math.min(samples.length - 1, Math.round((t0 + x / pxPerS) * ECG_SAMPLE_RATE_HZ)));
  const cx = (i / ECG_SAMPLE_RATE_HZ - t0) * pxPerS;
  const v = samples[i];
  const cy = height / 2 - (v / UNITS_PER_MM) * PX_PER_MM;
  return (
    <svg width={width} height={height} className="pointer-events-none absolute inset-0 overflow-visible">
      <Cursor x={cx} top={0} bottom={height} />
      <circle cx={cx} cy={cy} r={3.5} fill="var(--foreground)" stroke="var(--card)" strokeWidth={1.5} />
      <Tooltip x={cx} width={width} plotLeft={0} top={6} title="" lines={[{ text: `${fmt1(i / ECG_SAMPLE_RATE_HZ)} s · ${v} unità` }]} />
    </svg>
  );
}

/** A few seconds of the trace, small, for the Home. */
export function EcgPreview({ samples, seconds = 6 }: { samples: Int32Array; seconds?: number }) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current || width <= 0) return;
    // the first seconds fill the width, not taller than about 140 px (more seconds on a wide screen)
    const mm = Math.min(width / (seconds * STANDARD_SPEED), 2.6);
    // ±540 units: the clipped peaks (±500) just fit
    drawTrace(canvas.current, samples, { pxPerMm: mm, pxPerS: STANDARD_SPEED * mm, t0: 0, width, height: 2 * 27 * mm, grid: true, labels: false });
  }, [samples, width, seconds]);
  return (
    <div ref={ref} className="overflow-hidden rounded-md border">
      <canvas ref={canvas} className="block" />
    </div>
  );
}
