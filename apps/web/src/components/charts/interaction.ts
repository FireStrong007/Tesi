/**
 * Pointer/touch interaction shared by the charts: scrubbing (tooltip that follows
 * the finger or the mouse), taps, and horizontal zoom of the time axis.
 *
 * Touch:  one finger dragged sideways = scrub (the tooltip stays after lifting the finger),
 *         vertical drag = page scroll (touch-action: pan-y), two fingers = pinch zoom + pan,
 *         double tap = zoom in 3× there / back to the full range.
 * Mouse:  hover = tooltip, drag = pan (when zoomed), ctrl+wheel or trackpad pinch = zoom,
 *         horizontal wheel = pan, double click = zoom in / reset.
 *
 * Hover and zoom updates are coalesced to one per animation frame; discrete zoom steps
 * (buttons, double tap, mouse wheel notches) are animated instead of jumping.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

export interface TimeWindow {
  from: number;
  to: number;
}

export interface ChartInteractionOptions {
  /** the element that receives the pointer events (x positions are relative to it) */
  ref: RefObject<HTMLElement | null>;
  from: number;
  to: number;
  /** horizontal extent of the plot area inside the element, in px */
  plotLeft: number;
  plotWidth: number;
  zoomable?: boolean;
  /** maximum zoom factor (default 32×) */
  maxZoom?: number;
  /** a tap/click that did not move; x relative to the element */
  onTap?: (x: number) => void;
}

type Gesture =
  | { kind: "touch"; x0: number; y0: number; t0: number; moved: boolean }
  | { kind: "pinch"; d0: number; mid0: number; win0: TimeWindow }
  | { kind: "mouse"; x0: number; t0: number; win0: TimeWindow; moved: boolean }
  | { kind: "done" };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 320;
const ANIM_MS = 280;
const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);

/**
 * Window between a and b at progress e (0..1). The span changes geometrically around the
 * point that keeps its relative position, so zooming looks uniform rather than accelerating.
 */
function interpolate(a: TimeWindow, b: TimeWindow, e: number): TimeWindow {
  const s0 = a.to - a.from;
  const s1 = b.to - b.from;
  if (Math.abs(s1 - s0) < s0 * 1e-6) {
    const f = a.from + (b.from - a.from) * e;
    return { from: f, to: f + s0 };
  }
  const p = (b.from * s0 - a.from * s1) / (s0 - s1);
  const r = (p - a.from) / s0;
  const s = s0 * Math.pow(s1 / s0, e);
  return { from: p - r * s, to: p - r * s + s };
}

export function useChartInteraction(o: ChartInteractionOptions) {
  const { from, to, zoomable = false } = o;
  const [win, setWin] = useState<TimeWindow | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [panning, setPanning] = useState(false);
  /** latest requested window, ahead of React state while a frame is pending */
  const winRef = useRef<TimeWindow | null>(null);
  /** running zoom animation (requestAnimationFrame id) */
  const anim = useRef(0);

  // another day / workout: back to the full range
  const rangeKey = `${from}:${to}`;
  const [prevKey, setPrevKey] = useState(rangeKey);
  if (prevKey !== rangeKey) {
    setPrevKey(rangeKey);
    setWin(null);
    setHoverX(null);
    winRef.current = null;
    cancelAnimationFrame(anim.current);
    anim.current = 0;
  }

  const view = win ?? { from, to };
  const live = useRef({ ...o, view });
  live.current = { ...o, view };

  // ---- one state update per animation frame
  const frame = useRef(0);
  const pending = useRef<{ hover?: number | null; win?: TimeWindow | null }>({});
  const schedule = useCallback((p: { hover?: number | null; win?: TimeWindow | null }) => {
    if ("win" in p) winRef.current = p.win ?? null;
    Object.assign(pending.current, p);
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const q = pending.current;
      pending.current = {};
      if ("hover" in q) setHoverX(q.hover ?? null);
      if ("win" in q) setWin(q.win ?? null);
    });
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      cancelAnimationFrame(anim.current);
    },
    [],
  );

  /** stops a running animation where it is, so a gesture continues from what is on screen */
  const stopAnim = () => {
    if (!anim.current) return;
    cancelAnimationFrame(anim.current);
    anim.current = 0;
    const v = live.current.view;
    winRef.current = fit(v.from, v.to - v.from);
  };

  /** animates from what is on screen to `target` (null = full range) */
  const animateTo = (target: TimeWindow | null) => {
    cancelAnimationFrame(anim.current);
    const L = live.current;
    const start = L.view;
    const end = target ?? { from: L.from, to: L.to };
    // repeated steps (e.g. tapping + quickly) compound from the target, not from the frame on screen
    winRef.current = target;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ANIM_MS);
      if (k < 1) {
        setWin(interpolate(start, end, easeOut(k)));
        anim.current = requestAnimationFrame(step);
      } else {
        anim.current = 0;
        setWin(target);
      }
    };
    anim.current = requestAnimationFrame(step);
  };

  // ---- window math (always reads the latest props through `live`)
  const fit = useCallback((start: number, span: number): TimeWindow | null => {
    const L = live.current;
    const full = Math.max(1, L.to - L.from);
    const minSpan = full / (L.maxZoom ?? 32);
    const s = clamp(span, minSpan, full);
    if (s >= full * 0.999) return null;
    const f = clamp(start, L.from, L.to - s);
    return { from: f, to: f + s };
  }, []);
  const current = () => winRef.current ?? { from: live.current.from, to: live.current.to };
  const timeAtIn = (w: TimeWindow, x: number) => {
    const L = live.current;
    return w.from + ((x - L.plotLeft) / Math.max(1, L.plotWidth)) * (w.to - w.from);
  };
  const zoomAround = (t: number, factor: number, animated = false) => {
    const w = current();
    const span = w.to - w.from;
    const next = span / factor;
    const target = fit(t - ((t - w.from) / span) * next, next);
    if (animated) animateTo(target);
    else schedule({ win: target });
  };

  // ---- pointer handling
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ x: number; t: number } | null>(null);

  const relX = (e: { clientX: number }) => e.clientX - (live.current.ref.current?.getBoundingClientRect().left ?? 0);
  const relY = (e: { clientY: number }) => e.clientY - (live.current.ref.current?.getBoundingClientRect().top ?? 0);

  const tap = (x: number) => {
    const L = live.current;
    const now = performance.now();
    const prev = lastTap.current;
    if (L.zoomable && prev && now - prev.t < DOUBLE_TAP_MS && Math.abs(prev.x - x) < 30) {
      lastTap.current = null;
      if (winRef.current) animateTo(null);
      else zoomAround(timeAtIn(current(), x), 3, true);
      return;
    }
    lastTap.current = { x, t: now };
    L.onTap?.(x);
  };

  const startPinch = () => {
    const [a, b] = [...pts.current.values()];
    gesture.current = { kind: "pinch", d0: Math.max(24, Math.abs(a.x - b.x)), mid0: (a.x + b.x) / 2, win0: current() };
    schedule({ hover: null });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    stopAnim();
    const x = relX(e);
    pts.current.set(e.pointerId, { x, y: relY(e) });
    // keep receiving the moves even if the element under the finger is re-rendered away
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    if (e.pointerType === "mouse") {
      gesture.current = { kind: "mouse", x0: x, t0: performance.now(), win0: current(), moved: false };
      return;
    }
    if (pts.current.size === 1) {
      gesture.current = { kind: "touch", x0: x, y0: relY(e), t0: performance.now(), moved: false };
      schedule({ hover: x });
    } else if (pts.current.size === 2 && live.current.zoomable) {
      startPinch();
    } else {
      gesture.current = { kind: "done" };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const x = relX(e);
    const L = live.current;
    if (pts.current.has(e.pointerId)) pts.current.set(e.pointerId, { x, y: relY(e) });
    const g = gesture.current;
    if (!g) {
      if (e.pointerType === "mouse") schedule({ hover: x });
      return;
    }
    if (g.kind === "pinch") {
      if (pts.current.size < 2) return;
      const [a, b] = [...pts.current.values()];
      const d = Math.max(24, Math.abs(a.x - b.x));
      const mid = (a.x + b.x) / 2;
      const span0 = g.win0.to - g.win0.from;
      const span = (span0 * g.d0) / d;
      const anchor = timeAtIn(g.win0, g.mid0);
      const start = anchor - ((mid - L.plotLeft) / Math.max(1, L.plotWidth)) * span;
      schedule({ win: fit(start, span) });
    } else if (g.kind === "touch") {
      if (Math.abs(x - g.x0) > TAP_SLOP || Math.abs(relY(e) - g.y0) > TAP_SLOP) g.moved = true;
      schedule({ hover: x });
    } else if (g.kind === "mouse") {
      const dx = x - g.x0;
      if (Math.abs(dx) > 3) g.moved = true;
      if (winRef.current && g.moved) {
        const span = g.win0.to - g.win0.from;
        if (!panning) setPanning(true);
        schedule({ hover: null, win: fit(g.win0.from - (dx / Math.max(1, L.plotWidth)) * span, span) });
      } else schedule({ hover: x });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const x = relX(e);
    pts.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === "mouse") {
      gesture.current = null;
      setPanning(false);
      if (!g.moved) tap(x);
      return;
    }
    if (g?.kind === "touch" && !g.moved && performance.now() - g.t0 < 500) tap(x);
    // a finger left after a pinch does nothing until it is lifted too
    gesture.current = pts.current.size ? { kind: "done" } : null;
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    // the browser took over (e.g. vertical page scroll)
    pts.current.delete(e.pointerId);
    gesture.current = pts.current.size ? { kind: "done" } : null;
    setPanning(false);
    schedule({ hover: null });
  };

  const onPointerLeave = (e: ReactPointerEvent<HTMLElement>) => {
    // touch tooltips stay visible after lifting the finger, so they can be read
    if (e.pointerType === "mouse" && gesture.current?.kind !== "mouse") schedule({ hover: null });
  };

  // tapping anywhere else dismisses a sticky (touch) tooltip
  const hovering = hoverX !== null;
  useEffect(() => {
    if (!hovering) return;
    const onDown = (ev: PointerEvent) => {
      const el = live.current.ref.current;
      if (el && !el.contains(ev.target as Node)) schedule({ hover: null });
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [hovering, schedule]);

  // ctrl+wheel / trackpad pinch zooms, horizontal wheel pans; plain wheel still scrolls the page
  useEffect(() => {
    const el = o.ref.current;
    if (!el || !zoomable) return;
    const onWheel = (e: WheelEvent) => {
      const x = relX(e);
      if (e.ctrlKey) {
        e.preventDefault();
        const t = timeAtIn(current(), x);
        // a mouse wheel notch (or line/page mode) is a discrete step: animate it;
        // trackpad pinches send many small deltas: follow them directly
        if (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 40) zoomAround(t, e.deltaY < 0 ? 1.5 : 1 / 1.5, true);
        else {
          stopAnim();
          zoomAround(t, Math.exp(-e.deltaY * 0.012));
        }
      } else if (winRef.current && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        stopAnim();
        const w = current();
        const span = w.to - w.from;
        schedule({ win: fit(w.from + (e.deltaX / Math.max(1, live.current.plotWidth)) * span, span) });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [o.ref, zoomable, fit, schedule]); // eslint-disable-line react-hooks/exhaustive-deps

  const center = () => {
    const w = current();
    return hoverX !== null ? timeAtIn(w, hoverX) : (w.from + w.to) / 2;
  };

  return {
    view,
    zoomed: win !== null,
    /** current magnification, 1 = full range */
    zoom: (to - from) / Math.max(1, view.to - view.from),
    hoverX,
    panning,
    zoomIn: () => zoomAround(center(), 2, true),
    zoomOut: () => zoomAround(center(), 0.5, true),
    reset: () => animateTo(null),
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave },
  };
}

export type ChartInteraction = ReturnType<typeof useChartInteraction>;

// ---------------------------------------------------------------- sorted-series helpers

/** first index whose timestamp is >= t (points sorted by timestamp) */
export function lowerBound(points: { timestamp: number }[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].timestamp < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** the points inside [from, to] plus one on each side, so lines reach the edges */
export function visibleSlice<T extends { timestamp: number }>(points: T[], from: number, to: number): T[] {
  if (!points.length) return points;
  const a = Math.max(0, lowerBound(points, from) - 1);
  const b = Math.min(points.length, lowerBound(points, to) + 1);
  return a === 0 && b === points.length ? points : points.slice(a, b);
}

export function nearestPoint<T extends { timestamp: number }>(points: T[], t: number): T | null {
  if (!points.length) return null;
  const i = lowerBound(points, t);
  const a = points[i - 1];
  const b = points[i];
  if (!a) return b;
  if (!b) return a;
  return t - a.timestamp <= b.timestamp - t ? a : b;
}

/** last point with timestamp <= t */
export function pointAtOrBefore<T extends { timestamp: number }>(points: T[], t: number): T | null {
  const i = lowerBound(points, t + 1e-9) - 1;
  return i >= 0 ? points[i] : null;
}
