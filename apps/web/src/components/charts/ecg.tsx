/**
 * ECG traces on the standard paper grid: 25 mm/s, small squares 0.04 s (1 mm), large squares 0.2 s
 * (5 mm). Drawn on a <canvas> for speed: only the visible part is drawn, the scroll area around it
 * has the trace's whole width, so it scrolls with a finger on a phone. The vertical scale is in the
 * device's units (core gima/ecg.ts): 100 units per large square.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { ECG_CLIP, ECG_SAMPLE_RATE_HZ } from "@bridge/core/gima/ecg";
import { Button } from "@/components/ui/button";
import { useSize } from "@/hooks/use-size";

/** paper speed (mm per second) and the vertical scale (device units per mm) */
const MM_PER_S = 25;
const UNITS_PER_MM = 20;
/** the trace's band: ±600 units, so that the ±500 clipping is visible with room around it */
const HALF_MM = 30;
const ZOOMS = [2, 3, 4, 6, 8];

/** the page's colours, read when drawing (they follow the theme) */
const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function drawTrace(canvas: HTMLCanvasElement, samples: Int32Array, opts: { pxPerMm: number; x0: number; width: number; height: number; grid: boolean; labels: boolean }) {
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
  const primary = cssVar("--primary", "#cf5539");
  if (opts.grid) {
    // small squares (1 mm) then large (5 mm), aligned with the trace's start
    for (const [step, alpha] of [
      [1, 0.12],
      [5, 0.3],
    ] as const) {
      ctx.strokeStyle = primary;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = step === 5 ? 1 : 0.5;
      ctx.beginPath();
      const first = Math.ceil(opts.x0 / (step * mm)) * step * mm;
      for (let x = first; x <= opts.x0 + opts.width; x += step * mm) {
        ctx.moveTo(Math.round(x - opts.x0) + 0.5, 0);
        ctx.lineTo(Math.round(x - opts.x0) + 0.5, opts.height);
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
  // the trace
  const pxPerSample = (MM_PER_S * mm) / ECG_SAMPLE_RATE_HZ;
  const y = (v: number) => mid - (v / UNITS_PER_MM) * mm;
  const i0 = Math.max(0, Math.floor(opts.x0 / pxPerSample) - 1);
  const i1 = Math.min(samples.length - 1, Math.ceil((opts.x0 + opts.width) / pxPerSample) + 1);
  ctx.strokeStyle = cssVar("--foreground", "#111");
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) {
    const x = i * pxPerSample - opts.x0;
    if (i === i0) ctx.moveTo(x, y(samples[i]));
    else ctx.lineTo(x, y(samples[i]));
  }
  ctx.stroke();
  if (opts.labels) {
    // seconds along the bottom, every second (5 large squares)
    ctx.fillStyle = cssVar("--muted-foreground", "#666");
    ctx.font = "10px system-ui, sans-serif";
    const pxPerS = MM_PER_S * mm;
    for (let s = Math.ceil(opts.x0 / pxPerS); s * pxPerS <= opts.x0 + opts.width; s++) ctx.fillText(`${s} s`, s * pxPerS - opts.x0 + 3, opts.height - 4);
  }
}

/** Does the recording have samples at the clipping limit (peaks cut by the Gima app)? */
export const hasClipped = (samples: Int32Array) => samples.some((v) => Math.abs(v) >= ECG_CLIP);

/** The whole trace, scrollable and zoomable (buttons, or Ctrl + wheel). */
export function EcgTrace({ samples }: { samples: Int32Array }) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(2); // index in ZOOMS: 4 px per mm
  const [x0, setX0] = useState(0);
  const [theme, setTheme] = useState(0);
  const mm = ZOOMS[zoom];
  const height = 2 * HALF_MM * mm;
  const total = Math.ceil((samples.length / ECG_SAMPLE_RATE_HZ) * MM_PER_S * mm);

  // redraw when the theme changes (the grid and trace colours are the page's)
  useEffect(() => {
    const o = new MutationObserver(() => setTheme((t) => t + 1));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => o.disconnect();
  }, []);
  useEffect(() => {
    if (canvas.current && width > 0) drawTrace(canvas.current, samples, { pxPerMm: mm, x0, width, height, grid: true, labels: true });
  }, [samples, mm, x0, width, height, theme]);

  // keep the same moment in the middle when zooming
  const changeZoom = useCallback(
    (to: number) => {
      const el = scroller.current;
      const next = Math.max(0, Math.min(ZOOMS.length - 1, to));
      if (!el || next === zoom) return;
      const centre = (el.scrollLeft + el.clientWidth / 2) / ZOOMS[zoom];
      setZoom(next);
      requestAnimationFrame(() => {
        el.scrollLeft = centre * ZOOMS[next] - el.clientWidth / 2;
        setX0(el.scrollLeft);
      });
    },
    [zoom],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-1">
        <span className="text-muted-foreground mr-auto text-xs">25 mm/s · {UNITS_PER_MM * 5} unità per quadretto grande</span>
        <Button variant="outline" size="icon" className="size-8" onClick={() => changeZoom(zoom - 1)} disabled={zoom === 0} aria-label="Riduci zoom">
          <ZoomOutIcon />
        </Button>
        <Button variant="outline" size="icon" className="size-8" onClick={() => changeZoom(zoom + 1)} disabled={zoom === ZOOMS.length - 1} aria-label="Aumenta zoom">
          <ZoomInIcon />
        </Button>
      </div>
      <div ref={ref} className="rounded-lg border">
        <div
          ref={scroller}
          className="overflow-x-auto overscroll-x-contain"
          onScroll={(e) => setX0(e.currentTarget.scrollLeft)}
          onWheel={(e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            changeZoom(zoom + (e.deltaY < 0 ? 1 : -1));
          }}
          role="img"
          aria-label={`Tracciato ECG di ${Math.round(samples.length / ECG_SAMPLE_RATE_HZ)} secondi`}
        >
          <div style={{ width: total, height }} className="relative">
            <canvas ref={canvas} className="sticky left-0 block" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** A few seconds of the trace, small, for the Home. */
export function EcgPreview({ samples, seconds = 6 }: { samples: Int32Array; seconds?: number }) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current || width <= 0) return;
    // the first seconds fill the width, not taller than about 140 px (more seconds on a wide screen)
    const mm = Math.min(width / (seconds * MM_PER_S), 2.6);
    // ±540 units: the clipped peaks (±500) just fit
    drawTrace(canvas.current, samples, { pxPerMm: mm, x0: 0, width, height: 2 * 27 * mm, grid: true, labels: false });
  }, [samples, width, seconds]);
  return (
    <div ref={ref} className="overflow-hidden rounded-md border">
      <canvas ref={canvas} className="block" />
    </div>
  );
}
