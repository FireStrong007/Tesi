/**
 * HeartBridge's ECG pieces, used by Grafici → ECG (pages/charts.tsx) and the Home: the device's
 * assessment, the recording's values, the viewer (components/charts/ecg.tsx) with its notices, the
 * chart with one dot per recording and the Home's card. The assessments are the device's, never
 * the app's: every box that shows them says so once (NOT_A_DIAGNOSIS).
 */
import { useMemo } from "react";
import { SquareActivityIcon, TriangleAlertIcon } from "lucide-react";
import { useApp } from "@/app-context";
import { Cursor, Surface, Tooltip, labelStep } from "@/components/charts/charts";
import { EcgPreview, EcgTrace, hasClipped } from "@/components/charts/ecg";
import { useChartInteraction } from "@/components/charts/interaction";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@/hooks/use-query";
import { useSize } from "@/hooks/use-size";
import { NEVER_RECORDED } from "@/lib/empty-states";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { addDays, ecgBlob, ecgRecordings, startOfDay, type EcgRecording } from "@bridge/core/db/queries";
import { fmtDayMonth, fmtDayTitle, fmtInt, fmtTime, fmtWeekday, fmt1 } from "@bridge/core/format";
import { ECG_CLIP, ECG_NORMAL, ECG_SAMPLE_RATE_CONFIRMED, ECG_SAMPLE_RATE_HZ, ECG_UNIT, NOT_A_DIAGNOSIS, decodeEcg, ecgAssessment } from "@bridge/core/gima/ecg";

export { NOT_A_DIAGNOSIS };
export const assessmentOf = (r: EcgRecording) => ecgAssessment(r.is_afib, r.diagnose_type);
/** green for a normal rhythm, amber for every other assessment */
export const isNormal = (r: EcgRecording) => assessmentOf(r) === ECG_NORMAL;
export const assessmentColor = (normal: boolean) => (normal ? "var(--ecg-normal)" : "var(--ecg-other)");

/** where a recording opens: Grafici → ECG, the day view of that recording */
export const ecgHref = (r: EcgRecording) => `/charts?tab=ecg&period=day&day=${startOfDay(r.timestamp)}&t=${r.start_ms}`;

export function AssessmentBadge({ r }: { r: EcgRecording }) {
  const normal = isNormal(r);
  return (
    <Badge variant="outline" className="gap-1.5 whitespace-normal">
      <span className="size-2 shrink-0 rounded-full" style={{ background: assessmentColor(normal) }} />
      {assessmentOf(r)}
    </Badge>
  );
}

/** the measurement's values as the device recorded them; «–» where it did not */
export function EcgValues({ r, cols = 4 }: { r: EcgRecording; cols?: 2 | 4 }) {
  const items = [
    { label: "Battito", value: r.heart != null ? `${r.heart} bpm` : "–" },
    { label: "Pressione", value: r.sbp != null && r.dbp != null ? `${r.sbp}/${r.dbp} mmHg` : "–" },
    { label: "HRV", value: r.hrv != null ? `${r.hrv} ms` : "–" },
    { label: "Durata del tracciato", value: `${fmtInt(r.sample_count / ECG_SAMPLE_RATE_HZ)} s` },
  ];
  return (
    <div className={cn("grid grid-cols-2 gap-3", cols === 4 && "sm:grid-cols-4")}>
      {items.map((x) => (
        <div key={x.label} className="min-w-0">
          <div className="text-muted-foreground text-xs">{x.label}</div>
          <div className="tabular font-semibold">{x.value}</div>
        </div>
      ))}
    </div>
  );
}

/** the samples of a recording, from the device's copy */
export function useEcgSamples(r: EcgRecording | null | undefined) {
  const { db, user } = useApp();
  return useQuery(async () => {
    if (!r) return null;
    const blob = await ecgBlob(db, user.id, r.start_ms);
    return blob ? decodeEcg(blob) : null;
  }, [r?.start_ms, user.id]);
}

/** the trace on the ECG grid, with the notices about the time scale, the units and the clipping */
export function EcgViewer({ r }: { r: EcgRecording }) {
  const { data: samples } = useEcgSamples(r);
  const clipped = useMemo(() => (samples ? hasClipped(samples) : false), [samples]);
  return (
    <div className="space-y-3">
      {!ECG_SAMPLE_RATE_CONFIRMED && (
        <Alert className="border-amber-500/50 text-amber-800 dark:text-amber-200 [&>svg]:text-amber-600">
          <TriangleAlertIcon />
          <AlertTitle className="line-clamp-none">Scala dei tempi da confermare: le misure sul tracciato potrebbero non essere precise</AlertTitle>
        </Alert>
      )}
      {samples ? <EcgTrace samples={samples} /> : <div className="text-muted-foreground py-10 text-center text-sm">Caricamento del tracciato…</div>}
      <p className="text-muted-foreground text-xs">
        Asse verticale in {ECG_UNIT}, 100 per quadretto grande. I valori sono limitati a ±{ECG_CLIP}: i picchi più alti appaiono tagliati{clipped ? " (in questo tracciato ce ne sono)" : ""}.
      </p>
      <p className="text-muted-foreground border-t pt-3 text-xs">
        Parametri usati: {fmt1(ECG_SAMPLE_RATE_HZ)} campioni al secondo (250 Hz del dispositivo con media di 3 campioni){ECG_SAMPLE_RATE_CONFIRMED ? "" : ", da confermare"}; unità: {ECG_UNIT}
        {ECG_SAMPLE_RATE_CONFIRMED ? "" : ", da confermare"}; alla velocità standard di 25 mm/s i quadretti piccoli valgono 0,04 s e i grandi 0,2 s (a 50 mm/s 0,02 e 0,1 s).
      </p>
    </div>
  );
}

/**
 * One dot per recording over a week or a month, on the same date axis as the other charts of the
 * period (one slot per day, labels thinned out to 34 px: every other day on a month) with the same
 * tooltip: across, when it was taken (inside its day); up, the heart rate the device recorded;
 * green a normal rhythm, amber any other assessment; an empty circle near the axis when the device
 * recorded no heart rate. Hover or touch shows the recording, a click or a tap opens it.
 */
export function EcgDotsChart({ recordings, from, to, week, onOpen }: { recordings: EcgRecording[]; from: number; to: number; week: boolean; onOpen: (r: EcgRecording) => void }) {
  const [ref, { width: w }] = useSize<HTMLDivElement>();
  const height = 240;
  const padL = 40;
  const padR = 8;
  const padT = 8;
  const padB = 22;
  const days: number[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  const plotW = Math.max(1, w - padL - padR);
  const bw = plotW / Math.max(1, days.length);
  const axisY = height - padB;
  const hearts = recordings.map((r) => r.heart).filter((h): h is number => h != null);
  const lo = Math.min(40, ...hearts.map((h) => Math.floor((h - 10) / 10) * 10));
  const hi = Math.max(120, ...hearts.map((h) => Math.ceil((h + 10) / 10) * 10));
  // the bars of the other charts fill the middle 70% of their day: the dots stay inside it too
  const xOf = (r: EcgRecording) => {
    const i = Math.max(0, days.findIndex((d, k) => r.timestamp >= d && r.timestamp < (days[k + 1] ?? to)));
    const end = days[i + 1] ?? to;
    return padL + (i + 0.15 + (0.7 * (r.timestamp - days[i])) / Math.max(1, end - days[i])) * bw;
  };
  const yOf = (r: EcgRecording) => (r.heart != null ? padT + (1 - (r.heart - lo) / (hi - lo)) * (axisY - padT - 14) : axisY - 7);
  const nearest = (x: number | null) => {
    if (x == null || !recordings.length) return null;
    let best: EcgRecording | null = null;
    let dist = Infinity;
    for (const r of recordings) {
      const d = Math.abs(xOf(r) - x);
      if (d < dist) (best = r), (dist = d);
    }
    // within the dot's day slot (and at least a finger's width)
    return dist <= Math.max(14, bw / 2) ? best : null;
  };
  const ix = useChartInteraction({ ref, from: 0, to: days.length, plotLeft: padL, plotWidth: plotW, onTap: (x) => {
    const r = nearest(x);
    if (r) onOpen(r);
  } });
  const hit = nearest(ix.hoverX);
  const every = labelStep(bw, week ? 0 : 34);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  return (
    <Surface boxRef={ref} ix={ix} width={w} height={height} cursor={hit ? "cursor-pointer" : undefined}>
      {ticks.map((v) => {
        const y = padT + (1 - (v - lo) / (hi - lo)) * (axisY - padT - 14);
        return (
          <g key={v}>
            <line x1={padL} x2={w - padR} y1={y} y2={y} stroke="var(--chart-grid)" />
            <text x={padL - 6} y={y + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
              {v}
            </text>
          </g>
        );
      })}
      <line x1={padL} x2={w - padR} y1={axisY} y2={axisY} stroke="var(--border)" />
      {days.map((d, i) =>
        i % every === 0 ? (
          <text key={d} x={padL + i * bw + bw / 2} y={height - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
            {week ? fmtWeekday(d).toUpperCase() : fmtDayMonth(d)}
          </text>
        ) : null,
      )}
      {hit && <Cursor x={xOf(hit)} top={padT} bottom={axisY} />}
      {recordings.map((r) => {
        const color = assessmentColor(isNormal(r));
        const big = r === hit ? 1.5 : 0;
        return r.heart != null ? (
          <circle key={r.start_ms} cx={xOf(r)} cy={yOf(r)} r={5.5 + big} fill={color} stroke="var(--card)" strokeWidth={1.5} />
        ) : (
          <circle key={r.start_ms} cx={xOf(r)} cy={yOf(r)} r={4.5 + big} fill="var(--card)" stroke={color} strokeWidth={2} />
        );
      })}
      {hit && (
        <Tooltip
          x={xOf(hit)}
          width={w}
          plotLeft={padL}
          top={padT}
          title={`${fmtDayTitle(hit.timestamp)}, ${fmtTime(hit.timestamp)}`}
          lines={[
            { text: hit.heart != null ? `${hit.heart} bpm` : "Battito non registrato" },
            { text: assessmentOf(hit), color: assessmentColor(isNormal(hit)) },
          ]}
        />
      )}
    </Surface>
  );
}

/** The Home's «ECG»: the latest recording, its values, the device's assessment and a few seconds of trace. */
export function EcgHomeCard() {
  const { db, user, dataVersion } = useApp();
  const { data: last } = useQuery(async () => (await ecgRecordings(db, user.id, 0, 4_000_000_000))[0] ?? null, [user.id, dataVersion]);
  const { data: samples } = useEcgSamples(last);
  return (
    <button
      onClick={() => navigate(last ? ecgHref(last) : "/charts?tab=ecg&period=month")}
      className="bg-card hover:bg-accent/40 flex w-full flex-col gap-3 rounded-xl border p-4 text-left shadow-sm transition-colors"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="bg-primary/15 text-primary flex size-7 shrink-0 items-center justify-center rounded-full [&_svg]:size-4">
          <SquareActivityIcon />
        </span>
        ECG
        {last && (
          <span className="text-muted-foreground ml-auto text-xs font-normal">
            {fmtDayTitle(last.timestamp)}, {fmtTime(last.timestamp)}
          </span>
        )}
      </div>
      {last === null ? (
        <div className="text-muted-foreground text-sm">{NEVER_RECORDED.ecg}</div>
      ) : last ? (
        <>
          <EcgValues r={last} />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <AssessmentBadge r={last} />
            <span className="text-muted-foreground">{NOT_A_DIAGNOSIS}.</span>
          </div>
          {samples && <EcgPreview samples={samples} />}
        </>
      ) : null}
    </button>
  );
}
