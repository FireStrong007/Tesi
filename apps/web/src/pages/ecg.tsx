/**
 * HeartBridge's ECG page: the recordings of a month, and the selected one on the ECG grid with the
 * device's values and assessment (never a diagnosis of the app), and the parameters used to draw
 * it, which are still to be confirmed (core gima/ecg.ts).
 */
import { useMemo } from "react";
import { ActivityIcon, ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { useApp } from "@/app-context";
import { EcgPreview, EcgTrace, hasClipped } from "@/components/charts/ecg";
import { DateNav, EmptyState, PageBody, PageHeader, periodRange } from "@/components/page";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery } from "@/hooks/use-query";
import { NEVER_RECORDED, NEVER_RECORDED_HINT } from "@/lib/empty-states";
import { navigate, query, usePath } from "@/lib/router";
import { cn } from "@/lib/utils";
import { ecgBlob, ecgRecordings, startOfDay, type EcgRecording } from "@bridge/core/db/queries";
import { fmtDayTitle, fmtInt, fmtTime, fmt1 } from "@bridge/core/format";
import { ECG_CLIP, ECG_SAMPLE_RATE_CONFIRMED, ECG_SAMPLE_RATE_HZ, ECG_UNIT, NOT_A_DIAGNOSIS, decodeEcg, ecgAssessment } from "@bridge/core/gima/ecg";

/** the device's assessment as a badge: «Ritmo normale» plain, anything else highlighted */
export function AssessmentBadge({ r }: { r: EcgRecording }) {
  const text = ecgAssessment(r.is_afib, r.diagnose_type);
  const normal = r.is_afib !== 1 && r.diagnose_type === 1;
  const unknown = text === "Non classificato";
  return (
    <Badge variant={normal || unknown ? "secondary" : "outline"} className={cn("whitespace-normal", !normal && !unknown && "border-amber-500/60 text-amber-700 dark:text-amber-300")}>
      {text}
    </Badge>
  );
}

/** the measurement's values as the device recorded them; «–» where it did not */
export function EcgValues({ r }: { r: EcgRecording }) {
  const items = [
    { label: "Battito", value: r.heart != null ? `${r.heart} bpm` : "–" },
    { label: "Pressione", value: r.sbp != null && r.dbp != null ? `${r.sbp}/${r.dbp} mmHg` : "–" },
    { label: "HRV", value: r.hrv != null ? `${r.hrv} ms` : "–" },
    { label: "Durata del tracciato", value: `${fmtInt(r.sample_count / ECG_SAMPLE_RATE_HZ)} s` },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
function useSamples(r: EcgRecording | null) {
  const { db, user } = useApp();
  return useQuery(async () => {
    if (!r) return null;
    const blob = await ecgBlob(db, user.id, r.start_ms);
    return blob ? decodeEcg(blob) : null;
  }, [r?.start_ms, user.id]);
}

function Viewer({ r }: { r: EcgRecording }) {
  const { data: samples } = useSamples(r);
  const clipped = useMemo(() => (samples ? hasClipped(samples) : false), [samples]);
  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>
          {fmtDayTitle(r.timestamp)}, ore {fmtTime(r.timestamp)}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <AssessmentBadge r={r} />
          <span>{NOT_A_DIAGNOSIS}.</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        <EcgValues r={r} />
        {!ECG_SAMPLE_RATE_CONFIRMED && (
          <Alert className="border-amber-500/50 text-amber-800 dark:text-amber-200 [&>svg]:text-amber-600">
            <TriangleAlertIcon />
            <AlertTitle className="line-clamp-none">Scala dei tempi da confermare: le misure sul tracciato potrebbero non essere precise</AlertTitle>
          </Alert>
        )}
        {samples ? <EcgTrace samples={samples} /> : <div className="text-muted-foreground py-10 text-center text-sm">Caricamento del tracciato…</div>}
        <p className="text-muted-foreground text-xs">
          Asse verticale in {ECG_UNIT}. I valori sono limitati a ±{ECG_CLIP}: i picchi più alti appaiono tagliati{clipped ? " (in questo tracciato ce ne sono)" : ""}.
        </p>
        <p className="text-muted-foreground border-t pt-3 text-xs">
          Parametri usati: {fmt1(ECG_SAMPLE_RATE_HZ)} campioni al secondo (250 Hz del dispositivo con media di 3 campioni){ECG_SAMPLE_RATE_CONFIRMED ? "" : ", da confermare"}; unità: {ECG_UNIT}
          {ECG_SAMPLE_RATE_CONFIRMED ? "" : ", da confermare"}; carta a 25 mm/s, quadretti piccoli 0,04 s e grandi 0,2 s.
        </p>
      </CardContent>
    </Card>
  );
}

export function EcgPage() {
  const { db, user, available, dataVersion } = useApp();
  const path = usePath();
  const q = query(path);
  const day = Number(q.get("day")) || startOfDay(Date.now() / 1000);
  const selected = Number(q.get("t")) || null;
  const { from, to } = periodRange("month", day);
  const { data: list } = useQuery(() => ecgRecordings(db, user.id, from, to), [from, to, user.id, dataVersion]);
  const current = list?.find((r) => r.start_ms === selected) ?? list?.[0] ?? null;
  const open = (r: EcgRecording) => navigate(`/ecg?day=${day}&t=${r.start_ms}`, true);

  return (
    <>
      <PageHeader title="ECG" subtitle="Elettrocardiogrammi registrati dall'orologio" />
      <PageBody>
        {!available.ecg ? (
          <EmptyState icon={<ActivityIcon />} title={NEVER_RECORDED.ecg}>
            {NEVER_RECORDED_HINT}
          </EmptyState>
        ) : (
          <>
            <DateNav day={day} period="month" onChange={(d) => navigate(`/ecg?day=${d}`, true)} />
            {list && !list.length && <p className="text-muted-foreground py-6 text-center text-sm">Nessun elettrocardiogramma in questo mese.</p>}
            {current && <Viewer r={current} />}
            {!!list?.length && (
              <Card className="gap-2 py-3">
                <CardHeader className="px-4">
                  <CardTitle className="text-base">Registrazioni del mese ({list.length})</CardTitle>
                </CardHeader>
                <CardContent className="px-2">
                  <ul className="divide-y">
                    {list.map((r) => (
                      <li key={r.start_ms}>
                        <button
                          onClick={() => open(r)}
                          aria-current={r === current ? "true" : undefined}
                          className={cn("hover:bg-accent/50 flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left", r === current && "bg-accent")}
                        >
                          {/* the assessment under the date on a phone, beside it on a wider screen */}
                          <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                            <div className="min-w-0">
                              <div className="font-medium">
                                {fmtDayTitle(r.timestamp)}, {fmtTime(r.timestamp)}
                              </div>
                              <div className="text-muted-foreground text-xs">
                                {r.heart != null ? `${r.heart} bpm` : "battito non registrato"}
                                {r.sbp != null && r.dbp != null ? ` · ${r.sbp}/${r.dbp} mmHg` : ""}
                              </div>
                            </div>
                            <div>
                              <AssessmentBadge r={r} />
                            </div>
                          </div>
                          <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </PageBody>
    </>
  );
}

/** The Home's «ECG»: the latest recording, its values, the device's assessment and a few seconds of trace. */
export function EcgHomeCard() {
  const { db, user, dataVersion } = useApp();
  const { data: last } = useQuery(async () => (await ecgRecordings(db, user.id, 0, 4_000_000_000))[0] ?? null, [user.id, dataVersion]);
  const { data: samples } = useSamples(last ?? null);
  return (
    <button
      onClick={() => navigate(last ? `/ecg?day=${startOfDay(last.timestamp)}&t=${last.start_ms}` : "/ecg")}
      className="bg-card hover:bg-accent/40 flex w-full flex-col gap-3 rounded-xl border p-4 text-left shadow-sm transition-colors"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="bg-primary/15 text-primary flex size-7 shrink-0 items-center justify-center rounded-full [&_svg]:size-4">
          <ActivityIcon />
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
