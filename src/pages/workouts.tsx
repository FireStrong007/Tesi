import { useMemo, useState, type ReactNode } from "react";
import {
  ActivityIcon,
  BikeIcon,
  DumbbellIcon,
  FlameIcon,
  FootprintsIcon,
  GaugeIcon,
  HeartPulseIcon,
  HourglassIcon,
  MountainIcon,
  PersonStandingIcon,
  RouteIcon,
  TimerIcon,
  Trash2Icon,
  WavesIcon,
} from "lucide-react";
import { useApp } from "@/app-context";
import { TimeChart, type RefLine } from "@/components/charts/charts";
import { EmptyState, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery } from "@/hooks/use-query";
import { useSize } from "@/hooks/use-size";
import { deleteWorkout, getWorkout, listWorkouts, workoutLaps, workoutRecords, type TimeValue, type Workout, type WorkoutLap, type WorkoutRecord } from "@/lib/db/repo";
import { fmt1, fmtDay, fmtDistance, fmtDuration, fmtDurationWords, fmtInt, fmtPace, fmtTime } from "@/lib/format";
import { navigate, query, usePath } from "@/lib/router";
import { SPORT_NAMES, sportName } from "@/lib/sports";
import { cn } from "@/lib/utils";
import {
  cadenceUnit,
  distanceSplits,
  hrZones,
  paceLabel,
  parseSummary,
  smooth,
  sumNum,
  userMaxHr,
  usesPace,
  workoutCadence,
  workoutSteps,
  zoneThresholds,
  type HrZone,
  type WorkoutSummary,
} from "@/lib/workout";

export function SportIcon({ sport, className }: { sport: number | null; className?: string }) {
  const I = sport === 1 ? PersonStandingIcon : sport === 2 || sport === 21 ? BikeIcon : sport === 5 ? WavesIcon : sport === 11 ? FootprintsIcon : sport === 17 || sport === 16 ? MountainIcon : sport === 10 || sport === 4 ? DumbbellIcon : TimerIcon;
  return <I className={className} />;
}

const activeTime = (w: Workout) => w.timer_s ?? w.elapsed_s ?? w.end_time - w.start_time;
const fmtShort = (ts: number) => new Date(ts * 1000).toLocaleDateString("it-IT", { day: "numeric", month: "short" });

// ------------------------------------------------------------------ shared pieces

/** big value + label, like Gadgetbridge's activity tiles */
function Tile({ value, unit, label, icon, color }: { value: ReactNode; unit?: string; label: string; icon?: ReactNode; color?: string }) {
  return (
    <div className="bg-muted/40 flex min-w-0 items-center gap-3 rounded-xl border px-3 py-3">
      {icon && (
        <span className="text-muted-foreground shrink-0 [&_svg]:size-5" style={color ? { color } : undefined}>
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <div className="tabular truncate text-lg leading-tight font-semibold">
          {value}
          {unit && <span className="text-muted-foreground ml-1 text-xs font-normal">{unit}</span>}
        </div>
        <div className="text-muted-foreground truncate text-xs">{label}</div>
      </div>
    </div>
  );
}

function Section({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3 px-3 sm:px-4">{children}</CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ list

export function WorkoutsPage() {
  const { db, user } = useApp();
  const { data } = useQuery(() => listWorkouts(db, user.id), [user.id]);
  const [sport, setSport] = useState<number | null>(null);
  const sports = useMemo(() => {
    const m = new Map<number, number>();
    for (const w of data ?? []) m.set(w.sport ?? 0, (m.get(w.sport ?? 0) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  }, [data]);
  const list = useMemo(() => (data ?? []).filter((w) => sport === null || (w.sport ?? 0) === sport), [data, sport]);
  const groups = useMemo(() => {
    const g = new Map<string, Workout[]>();
    for (const w of list) {
      const k = new Date(w.start_time * 1000).toLocaleDateString("it-IT", { month: "long", year: "numeric" });
      g.set(k, [...(g.get(k) ?? []), w]);
    }
    return [...g.entries()];
  }, [list]);
  const total = (f: (w: Workout) => number | null | undefined) => list.reduce((s, w) => s + (f(w) ?? 0), 0);

  return (
    <>
      <PageHeader title="Attività sportive" subtitle={data ? `${data.length} ${data.length === 1 ? "attività registrata" : "attività registrate"}` : undefined} />
      <PageBody>
        {data && data.length === 0 && (
          <EmptyState icon={<TimerIcon />} title="Nessuna attività">
            Avvia un'attività sul bracciale (corsa, camminata, bici…) e sincronizza: comparirà qui con durata, distanza, battito, giri e grafici.
          </EmptyState>
        )}
        {data && data.length > 0 && (
          <>
            {sports.length > 1 && (
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none]" role="tablist" aria-label="Filtra per sport">
                {[null, ...sports].map((s) => (
                  <button
                    key={s ?? "all"}
                    role="tab"
                    aria-selected={sport === s}
                    onClick={() => setSport(s)}
                    className={cn(
                      "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                      sport === s ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent",
                    )}
                  >
                    {s !== null && <SportIcon sport={s} className="size-4" />}
                    {s === null ? "Tutte" : (SPORT_NAMES[s] ?? "Altro")}
                  </button>
                ))}
              </div>
            )}
            <Card className="gap-3 py-4">
              <CardHeader className="px-4">
                <CardTitle className="text-lg">{sport === null ? "Tutte le attività" : SPORT_NAMES[sport]}</CardTitle>
                {list.length > 0 && (
                  <CardDescription>
                    {fmtShort(list[list.length - 1].start_time)} – {fmtShort(list[0].start_time)} · {list.length} attività
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-2 px-4 sm:grid-cols-4">
                <Tile icon={<RouteIcon />} value={fmtDistance(total((w) => w.distance_m))} label="Distanza" />
                <Tile icon={<FlameIcon />} value={fmtInt(total((w) => w.calories))} unit="kcal" label="Calorie" />
                <Tile icon={<TimerIcon />} value={fmtDurationWords(total(activeTime))} label="Tempo attivo" />
                <Tile icon={<HourglassIcon />} value={fmtDurationWords(total((w) => w.elapsed_s ?? w.end_time - w.start_time))} label="Durata" />
              </CardContent>
            </Card>
          </>
        )}
        {groups.map(([month, ws]) => {
          const km = ws.reduce((s, w) => s + (w.distance_m ?? 0), 0);
          return (
            <section key={month} className="space-y-2">
              <h2 className="text-muted-foreground flex items-baseline justify-between px-1 text-sm font-medium">
                <span className="capitalize">{month}</span>
                <span className="tabular text-xs font-normal">
                  {ws.length} attività
                  {km > 0 && ` · ${fmtDistance(km)}`}
                </span>
              </h2>
              <Card className="gap-0 py-0">
                {ws.map((w, i) => (
                  <button key={w.id} onClick={() => navigate(`/workouts/${w.id}`)} className={cn("hover:bg-accent/40 flex w-full items-center gap-3 px-4 py-3 text-left", i > 0 && "border-t")}>
                    <div className="bg-accent text-accent-foreground flex size-11 shrink-0 items-center justify-center rounded-full">
                      <SportIcon sport={w.sport} className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{sportName(w.sport, w.name)}</div>
                      <div className="text-muted-foreground tabular truncate text-sm">
                        {[w.distance_m ? fmtDistance(w.distance_m) : null, fmtDurationWords(activeTime(w)), w.avg_hr ? `${w.avg_hr} bpm` : null].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <div className="text-muted-foreground tabular shrink-0 text-right text-sm">
                      <div>{fmtDay(w.start_time)}</div>
                      <div>{fmtTime(w.start_time)}</div>
                    </div>
                  </button>
                ))}
              </Card>
            </section>
          );
        })}
      </PageBody>
    </>
  );
}

// ------------------------------------------------------------------ detail

const TABS = [
  { id: "overview", label: "Panoramica" },
  { id: "laps", label: "Giri" },
  { id: "charts", label: "Grafici" },
  { id: "details", label: "Dettagli" },
] as const;

export function WorkoutDetailPage({ id }: { id: number }) {
  const { db, bumpData, user } = useApp();
  const path = usePath();
  const tab = query(path).get("tab") ?? "overview";
  const { data: w } = useQuery(() => getWorkout(db, id), [id]);
  const { data: recs } = useQuery(() => workoutRecords(db, id), [id]);
  const { data: laps } = useQuery(() => workoutLaps(db, id), [id]);
  const [confirm, setConfirm] = useState(false);
  const d = useMemo(() => (w ? derive(w, recs ?? [], userMaxHr(user)) : null), [w, recs, user]);
  if (!w || !d) return <PageHeader title="Attività" back={() => navigate("/workouts")} />;

  return (
    <>
      <PageHeader
        title={sportName(w.sport, w.name)}
        subtitle={fmtDay(w.start_time)}
        back={() => navigate("/workouts")}
        actions={
          <Button variant="ghost" size="icon" aria-label="Elimina" onClick={() => setConfirm(true)}>
            <Trash2Icon />
          </Button>
        }
      />
      <PageBody>
        <Tabs value={tab} onValueChange={(t) => navigate(`/workouts/${id}?tab=${t}`, true)} className="gap-4">
          <TabsList className="grid h-10 w-full grid-cols-4">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="px-1 text-xs sm:text-sm">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="overview" className="space-y-4">
            <Overview w={w} d={d} />
          </TabsContent>
          <TabsContent value="laps" className="space-y-4">
            <Laps w={w} laps={laps ?? []} d={d} />
          </TabsContent>
          <TabsContent value="charts" className="space-y-4">
            <Charts w={w} d={d} />
          </TabsContent>
          <TabsContent value="details" className="space-y-4">
            <Details w={w} d={d} />
          </TabsContent>
        </Tabs>
      </PageBody>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eliminare l'attività?</DialogTitle>
            <DialogDescription>Il file FIT originale resta salvato e può essere reimportato rielaborando i file.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Annulla
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                await deleteWorkout(db, id);
                bumpData();
                toast.success("Attività eliminata");
                navigate("/workouts");
              }}
            >
              Elimina
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type Derived = ReturnType<typeof derive>;

/** everything the tabs show, computed once per activity */
function derive(w: Workout, recs: WorkoutRecord[], fallbackMaxHr: number | null) {
  const s = parseSummary(w);
  const from = w.start_time;
  const to = Math.max(w.end_time, recs.length ? recs[recs.length - 1].timestamp : 0, from + 60);
  const series = (f: (r: WorkoutRecord) => number | null | undefined): TimeValue[] =>
    recs.flatMap((r) => {
      const v = f(r);
      return v == null ? [] : [{ timestamp: r.timestamp, value: v }];
    });
  const hr = series((r) => r.heart_rate || null);
  // pace from the speed smoothed over 20 s; standing still (< 0.5 m/s = 33:20 min/km) is a gap
  const speed = smooth(series((r) => r.speed), 20).filter((p) => p.value >= 0.5);
  const cadence = smooth(series((r) => workoutCadence(w.sport, r.cadence) || null), 10);
  const temperature = series((r) => r.temperature);
  const altitude = series((r) => r.altitude);
  const distance = series((r) => (r.distance != null ? r.distance / 1000 : null));
  const track = recs.filter((r) => r.lat != null && r.lon != null);
  const thresholds = zoneThresholds(s, fallbackMaxHr);
  const zones = thresholds && hr.length ? hrZones(recs, thresholds) : null;
  const minMax = (p: TimeValue[]) => (p.length ? p.reduce((a, b) => ({ min: Math.min(a.min, b.value), max: Math.max(a.max, b.value) }), { min: Infinity, max: -Infinity }) : null);
  const resting = sumNum(s, "metabolic_calories");
  return {
    s,
    from,
    to,
    hr,
    speed,
    cadence,
    temperature,
    altitude,
    distance,
    track,
    thresholds,
    zones,
    splits: distanceSplits(recs),
    pace: usesPace(w.sport),
    maxSpeed: sumNum(s, "enhanced_max_speed") ?? sumNum(s, "max_speed") ?? minMax(speed)?.max ?? null,
    avgCadence: workoutCadence(w.sport, (sumNum(s, "avg_cadence") ?? 0) + (sumNum(s, "avg_fractional_cadence") ?? 0) || null) ?? (cadence.length ? cadence.reduce((a, b) => a + b.value, 0) / cadence.length : null),
    maxCadence: workoutCadence(w.sport, sumNum(s, "max_cadence")) ?? minMax(cadence)?.max ?? null,
    temp: { min: sumNum(s, "min_temperature") ?? minMax(temperature)?.min ?? null, max: sumNum(s, "max_temperature") ?? minMax(temperature)?.max ?? null, avg: sumNum(s, "avg_temperature") },
    alt: minMax(altitude),
    minHr: sumNum(s, "min_heart_rate") ?? minMax(hr)?.min ?? null,
    steps: workoutSteps(w),
    /** total includes the resting (metabolic) calories when the band reports them */
    activeCalories: w.calories != null && resting != null ? w.calories - resting : w.calories,
    restingCalories: resting,
  };
}

const speedText = (pace: boolean, v: number | null | undefined) => (pace ? fmtPace(v) : v ? `${fmt1(v * 3.6)} km/h` : "–");

// ------------------------------------------------------------------ overview

function Overview({ w, d }: { w: Workout; d: Derived }) {
  const te = sumNum(d.s, "total_training_effect");
  return (
    <>
      <Card className="py-4">
        <CardContent className="flex items-center gap-4 px-4">
          <div className="bg-accent text-accent-foreground flex size-14 shrink-0 items-center justify-center rounded-full">
            <SportIcon sport={w.sport} className="size-7" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold">{sportName(w.sport, w.name)}</div>
            <div className="text-muted-foreground tabular text-sm">
              {fmtDay(w.start_time)}, {fmtTime(w.start_time)} – {fmtTime(w.end_time)} · {fmtDurationWords(activeTime(w))}
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile icon={<TimerIcon />} value={fmtDurationWords(activeTime(w))} label="Tempo attivo" />
        {w.distance_m ? <Tile icon={<RouteIcon />} value={fmtDistance(w.distance_m)} label="Distanza" /> : null}
        {d.steps ? <Tile icon={<FootprintsIcon />} value={fmtInt(d.steps)} label="Passi" color="var(--steps)" /> : null}
        <Tile icon={<FlameIcon />} value={fmtInt(d.activeCalories)} unit="kcal" label={d.restingCalories != null ? "Calorie attive" : "Calorie"} color="var(--calories)" />
        {w.avg_hr ? <Tile icon={<HeartPulseIcon />} value={fmtInt(w.avg_hr)} unit="bpm" label="Battito medio" color="var(--heart)" /> : null}
        {w.avg_speed ? <Tile icon={<GaugeIcon />} value={speedText(d.pace, w.avg_speed)} label={d.pace ? "Ritmo medio" : "Velocità media"} /> : null}
        {w.ascent_m ? <Tile icon={<MountainIcon />} value={fmtInt(w.ascent_m)} unit="m" label="Salita" /> : null}
        {te != null ? <Tile icon={<ActivityIcon />} value={fmt1(te)} label="Effetto aerobico" /> : null}
      </div>
      {d.zones && <ZonesCard zones={d.zones} compact />}
      {d.track.length > 1 && (
        <Section title="Percorso">
          <Route points={d.track} />
        </Section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ laps

function Laps({ w, laps, d }: { w: Workout; laps: WorkoutLap[]; d: Derived }) {
  const fileLaps = laps.filter((l) => (l.timer_s ?? l.elapsed_s ?? 0) > 0);
  const rows: LapRow[] =
    fileLaps.length > 1
      ? fileLaps.map((l, i) => ({ n: i + 1, distance: l.distance_m, speed: l.avg_speed ?? (l.distance_m && l.timer_s ? l.distance_m / l.timer_s : null), hr: l.avg_hr, seconds: l.timer_s ?? l.elapsed_s }))
      : d.splits.map((s) => ({ n: s.index, distance: s.distance_m, speed: s.speed, hr: s.avg_hr, seconds: s.seconds }));
  if (!rows.length)
    return (
      <EmptyState icon={<RouteIcon />} title="Nessun giro">
        Questa attività non ha giri né distanza registrata. Se è stata importata con una versione precedente dell'app, usa «Rielabora file» nelle impostazioni del dispositivo.
      </EmptyState>
    );
  return (
    <Section
      title={fileLaps.length > 1 ? "Giri" : "Parziali al km"}
      description={fileLaps.length > 1 ? "Giri registrati dal bracciale (automatici o manuali)" : "Calcolati dalla distanza registrata durante l'attività"}
    >
      <LapTable rows={rows} pace={d.pace} />
      {fileLaps.length > 1 && d.splits.length > 1 && fileLaps.length !== d.splits.length && (
        <details className="pt-2">
          <summary className="text-muted-foreground cursor-pointer text-sm">Parziali al km</summary>
          <div className="pt-2">
            <LapTable rows={d.splits.map((s) => ({ n: s.index, distance: s.distance_m, speed: s.speed, hr: s.avg_hr, seconds: s.seconds }))} pace={d.pace} />
          </div>
        </details>
      )}
      {w.distance_m ? (
        <div className="text-muted-foreground flex justify-between border-t pt-3 text-sm">
          <span>Totale</span>
          <span className="tabular">
            {fmtDistance(w.distance_m)} · {speedText(d.pace, w.avg_speed)} · {fmtDuration(activeTime(w))}
          </span>
        </div>
      ) : null}
    </Section>
  );
}

interface LapRow {
  n: number;
  distance: number | null;
  speed: number | null;
  hr: number | null;
  seconds: number | null;
}

function LapTable({ rows, pace }: { rows: LapRow[]; pace: boolean }) {
  const speeds = rows.map((r) => r.speed ?? 0);
  const fastest = Math.max(...speeds);
  const slowest = Math.min(...speeds.filter((s) => s > 0));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground border-b text-xs tracking-wide uppercase">
            <th className="py-2 pr-2 text-left font-medium">#</th>
            <th className="px-2 py-2 text-right font-medium">Distanza</th>
            <th className="px-2 py-2 text-left font-medium">
              {pace ? "Ritmo" : "Velocità"}
              <div className="text-[10px] normal-case">{pace ? "min/km" : "km/h"}</div>
            </th>
            <th className="px-2 py-2 text-right font-medium">
              Battito
              <div className="text-[10px] normal-case">bpm</div>
            </th>
            <th className="py-2 pl-2 text-right font-medium">Tempo</th>
          </tr>
        </thead>
        <tbody className="tabular">
          {rows.map((r) => {
            const best = r.speed != null && r.speed === fastest && rows.length > 1;
            // bar length: slowest lap = 35 %, fastest = 100 %
            const pct = r.speed && fastest > slowest ? 35 + ((r.speed - slowest) / (fastest - slowest)) * 65 : 100;
            return (
              <tr key={r.n} className="border-b last:border-0">
                <td className="text-muted-foreground py-2.5 pr-2">{r.n}</td>
                <td className="px-2 py-2.5 text-right">{r.distance != null ? (r.distance >= 1000 ? `${fmt1(r.distance / 1000)} km` : `${fmtInt(r.distance)} m`) : "–"}</td>
                <td className="w-[38%] px-2 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className={cn("w-12 shrink-0", best && "text-primary font-semibold")}>{pace ? paceLabel(r.speed) : r.speed ? fmt1(r.speed * 3.6) : "–"}</span>
                    <span className="bg-muted hidden h-1.5 flex-1 overflow-hidden rounded-full min-[400px]:block">
                      <span className={cn("block h-full rounded-full", best ? "bg-primary" : "bg-primary/45")} style={{ width: `${pct}%` }} />
                    </span>
                  </div>
                </td>
                <td className="px-2 py-2.5 text-right">{fmtInt(r.hr)}</td>
                <td className="py-2.5 pl-2 text-right">{fmtDuration(r.seconds)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ charts

function Charts({ w, d }: { w: Workout; d: Derived }) {
  const common = { from: d.from, to: d.to, xTicks: "elapsed" as const, height: 200 };
  const zoneLines: RefLine[] = (d.thresholds ?? []).map((t, i) => ({ value: t, color: `var(--zone-${i + 2})` }));
  const hrMax = d.hr.reduce((m, p) => Math.max(m, p.value), 0);
  const none = !d.hr.length && !d.speed.length && !d.cadence.length && !d.temperature.length && !d.altitude.length && !d.distance.length;
  if (none)
    return (
      <EmptyState icon={<HeartPulseIcon />} title="Nessun grafico">
        L'attività non contiene dati registrati durante l'allenamento (battito, ritmo, cadenza…).
      </EmptyState>
    );
  return (
    <>
      {d.hr.length > 0 && (
        <Section title="Pulsazioni">
          <div className="grid grid-cols-3 gap-2">
            <Tile value={fmtInt(w.avg_hr)} unit="bpm" label="Medio" color="var(--heart)" />
            <Tile value={fmtInt(w.max_hr ?? hrMax)} unit="bpm" label="Massimo" />
            <Tile value={fmtInt(d.minHr)} unit="bpm" label="Minimo" />
          </div>
          <TimeChart
            {...common}
            height={220}
            yMax={Math.max(hrMax, ...(d.thresholds ?? [0])) + 5}
            refLines={zoneLines.filter((l) => l.value < hrMax + 5)}
            series={[{ points: d.hr, color: "var(--heart)", area: true, gap: 60, label: "bpm" }]}
          />
        </Section>
      )}
      {d.zones && <ZonesCard zones={d.zones} />}
      {d.speed.length > 0 && (
        <Section title={d.pace ? "Ritmo" : "Velocità"}>
          <div className="grid grid-cols-2 gap-2">
            <Tile value={speedText(d.pace, w.avg_speed)} label={d.pace ? "Ritmo medio" : "Velocità media"} />
            <Tile value={speedText(d.pace, d.maxSpeed)} label={d.pace ? "Ritmo più veloce" : "Velocità massima"} />
          </div>
          <TimeChart
            {...common}
            // the chart plots speed: faster is higher, labels show the pace
            yMin={d.pace ? undefined : 0}
            format={d.pace ? paceLabel : (v) => fmt1(v * 3.6)}
            series={[{ points: d.speed, color: "var(--energy)", gap: 30, label: d.pace ? "min/km" : "km/h", width: 1.5 }]}
          />
        </Section>
      )}
      {d.cadence.length > 0 && (
        <Section title="Cadenza">
          <div className="grid grid-cols-2 gap-2">
            <Tile value={fmtInt(d.avgCadence)} unit={cadenceUnit(w.sport)} label="Media" />
            <Tile value={fmtInt(d.maxCadence)} unit={cadenceUnit(w.sport)} label="Massima" />
          </div>
          <TimeChart {...common} yMin={0} series={[{ points: d.cadence, color: "var(--calories)", gap: 30, label: cadenceUnit(w.sport), width: 1.5 }]} />
        </Section>
      )}
      {d.temperature.length > 0 && (
        <Section title="Temperatura">
          <div className="grid grid-cols-2 gap-2">
            <Tile value={fmtInt(d.temp.min)} unit="°C" label="Minima" />
            <Tile value={fmtInt(d.temp.max)} unit="°C" label="Massima" />
          </div>
          <TimeChart {...common} height={160} series={[{ points: d.temperature, color: "var(--stress-high)", gap: 120, label: "°C", kind: "step" }]} />
        </Section>
      )}
      {d.altitude.length > 0 && (
        <Section title="Altitudine">
          <div className="grid grid-cols-2 gap-2">
            <Tile value={fmtInt(w.ascent_m)} unit="m" label="Salita" />
            <Tile value={fmtInt(w.descent_m)} unit="m" label="Discesa" />
          </div>
          <TimeChart {...common} height={160} series={[{ points: d.altitude, color: "var(--resp)", area: true, gap: 120, label: "m" }]} />
        </Section>
      )}
      {d.distance.length > 0 && (
        <Section title="Distanza">
          <TimeChart {...common} height={180} yMin={0} format={(v) => fmt1(v)} series={[{ points: d.distance, color: "var(--steps)", gap: 120, label: "km" }]} />
        </Section>
      )}
    </>
  );
}

function ZonesCard({ zones, compact = false }: { zones: HrZone[]; compact?: boolean }) {
  const total = zones.reduce((s, z) => s + z.seconds, 0) || 1;
  const range = (z: HrZone) => (z.lo == null ? `< ${z.hi}` : z.hi == null ? `> ${z.lo}` : `${z.lo} – ${z.hi}`);
  const main = zones.reduce((a, b) => (b.seconds > a.seconds ? b : a));
  return (
    <Section title="Zone cardiache" description={compact ? `Soprattutto in zona ${main.name.toLowerCase()} (${Math.round((main.seconds / total) * 100)}%)` : "Tempo trascorso in ogni zona di frequenza cardiaca"}>
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {zones.map((z) => (z.seconds > 0 ? <div key={z.name} style={{ width: `${(z.seconds / total) * 100}%`, background: z.color }} title={z.name} /> : null))}
      </div>
      {!compact && (
        <ul className="space-y-1.5 text-sm">
          {zones.map((z) => (
            <li key={z.name} className="flex items-center gap-2">
              <span className="size-3 shrink-0 rounded-sm" style={{ background: z.color }} />
              <span className="min-w-0 flex-1 truncate">
                {z.name} <span className="text-muted-foreground tabular">({range(z)})</span>
              </span>
              <span className="tabular text-right">
                {z.seconds ? (
                  <>
                    {fmtDurationWords(z.seconds)} <span className="text-muted-foreground">({Math.round((z.seconds / total) * 100)}%)</span>
                  </>
                ) : (
                  "–"
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ details

function Details({ w, d }: { w: Workout; d: Derived }) {
  const s: WorkoutSummary = d.s;
  const n = (k: string) => sumNum(s, k);
  const v = (x: number | null | undefined, f: (x: number) => string) => (x == null ? null : f(x));
  const bpm = (x: number) => `${fmtInt(x)} bpm`;
  const sections: { title: string; rows: [string, string | null][] }[] = [
    {
      title: "Tempo",
      rows: [
        ["Inizio", `${fmtDay(w.start_time)}, ${fmtTime(w.start_time)}`],
        ["Fine", fmtTime(w.end_time)],
        ["Tempo attivo", fmtDurationWords(activeTime(w))],
        ["Durata totale", v(w.elapsed_s, fmtDurationWords)],
        ["Tempo in movimento", v(n("total_moving_time"), fmtDurationWords)],
      ],
    },
    {
      title: "Pulsazioni",
      rows: [
        ["Battito medio", v(w.avg_hr, bpm)],
        ["Battito massimo", v(w.max_hr, bpm)],
        ["Battito minimo", v(d.minHr, bpm)],
        ["Battito a riposo", v(s._zones?.resting_hr, bpm)],
        ["Battito massimo dell'utente", v(s._zones?.max_hr, bpm)],
        ["Battito di recupero", v(n("recovery_heart_rate"), bpm)],
      ],
    },
    {
      title: d.pace ? "Ritmo" : "Velocità",
      rows: [
        [d.pace ? "Ritmo medio" : "Velocità media", w.avg_speed ? speedText(d.pace, w.avg_speed) : null],
        [d.pace ? "Ritmo più veloce" : "Velocità massima", d.maxSpeed ? speedText(d.pace, d.maxSpeed) : null],
        [d.pace ? "Velocità media" : "Ritmo medio", w.avg_speed ? speedText(!d.pace, w.avg_speed) : null],
      ],
    },
    {
      title: "Cadenza",
      rows: [
        ["Cadenza media", v(d.avgCadence, (x) => `${fmt1(x)} ${cadenceUnit(w.sport)}`)],
        ["Cadenza massima", v(d.maxCadence, (x) => `${fmtInt(x)} ${cadenceUnit(w.sport)}`)],
        ["Lunghezza media del passo", v(n("avg_step_length"), (x) => `${fmt1(x / 10)} cm`)],
      ],
    },
    {
      title: "Effetto allenamento",
      rows: [
        ["Effetto aerobico", v(n("total_training_effect"), fmt1)],
        ["Effetto anaerobico", v(n("total_anaerobic_training_effect"), fmt1)],
        ["Carico di allenamento", v(n("training_load_peak"), fmtInt)],
        ["Body Battery all'inizio", v(n("beginning_body_battery"), (x) => `${fmtInt(x)} %`)],
        ["Body Battery alla fine", v(n("ending_body_battery"), (x) => `${fmtInt(x)} %`)],
      ],
    },
    {
      title: "Temperatura",
      rows: [
        ["Minima", v(d.temp.min, (x) => `${fmtInt(x)} °C`)],
        ["Massima", v(d.temp.max, (x) => `${fmtInt(x)} °C`)],
        ["Media", v(d.temp.avg, (x) => `${fmtInt(x)} °C`)],
      ],
    },
    {
      title: "Distanza e quota",
      rows: [
        ["Distanza", w.distance_m ? fmtDistance(w.distance_m) : null],
        ["Salita", v(w.ascent_m, (x) => `${fmtInt(x)} m`)],
        ["Discesa", v(w.descent_m, (x) => `${fmtInt(x)} m`)],
        ["Quota minima", v(n("enhanced_min_altitude") ?? d.alt?.min, (x) => `${fmtInt(x)} m`)],
        ["Quota massima", v(n("enhanced_max_altitude") ?? d.alt?.max, (x) => `${fmtInt(x)} m`)],
        ["Piani saliti", v(n("floors_ascended"), fmtInt)],
      ],
    },
    { title: "Passi", rows: [["Passi", v(d.steps, (x) => `${fmtInt(x)} passi`)]] },
    {
      title: "Altro",
      rows: [
        ["Calorie totali", v(w.calories, (x) => `${fmtInt(x)} kcal`)],
        ["Calorie attive", d.restingCalories != null ? v(d.activeCalories, (x) => `${fmtInt(x)} kcal`) : null],
        ["Calorie a riposo", v(d.restingCalories, (x) => `${fmtInt(x)} kcal`)],
        ["Respirazione media", v(n("enhanced_avg_respiration_rate") ?? n("avg_respiration_rate"), (x) => `${fmt1(x)} resp/min`)],
        ["Perdita di sudore stimata", v(n("estimated_sweat_loss"), (x) => `${fmtInt(x)} ml`)],
      ],
    },
  ];
  return (
    <>
      {sections.map((sec) => {
        const rows = sec.rows.filter((r): r is [string, string] => r[1] != null);
        if (!rows.length) return null;
        return (
          <Card key={sec.title} className="gap-0 py-0">
            <div className="px-4 pt-4 pb-2 text-base font-semibold">{sec.title}</div>
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4 border-t px-4 py-3 text-sm">
                <span className="text-muted-foreground">{label}</span>
                <span className="tabular text-right font-medium">{value}</span>
              </div>
            ))}
          </Card>
        );
      })}
    </>
  );
}

// ------------------------------------------------------------------ route

/** Draws the GPS track as an SVG polyline (equirectangular projection, no map tiles: nothing leaves the device). */
function Route({ points }: { points: WorkoutRecord[] }) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const h = 240;
  const lats = points.map((p) => p.lat!);
  const lons = points.map((p) => p.lon!);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const k = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const spanX = (maxLon - minLon) * k || 1e-6;
  const spanY = maxLat - minLat || 1e-6;
  const scale = Math.min((width - 24) / spanX, (h - 24) / spanY);
  const ox = (width - spanX * scale) / 2;
  const oy = (h - spanY * scale) / 2;
  const pt = (p: WorkoutRecord) => [ox + (p.lon! - minLon) * k * scale, oy + (maxLat - p.lat!) * scale];
  const d = points.map((p, i) => `${i ? "L" : "M"}${pt(p).join(",")}`).join("");
  const [sx, sy] = pt(points[0]);
  const [ex, ey] = pt(points[points.length - 1]);
  return (
    <div ref={ref} className="bg-muted/50 w-full overflow-hidden rounded-lg" style={{ height: h }}>
      {width > 0 && (
        <svg width={width} height={h}>
          <path d={d} fill="none" stroke="var(--primary)" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={sx} cy={sy} r={6} fill="var(--steps)" stroke="var(--card)" strokeWidth={2} />
          <circle cx={ex} cy={ey} r={6} fill="var(--heart)" stroke="var(--card)" strokeWidth={2} />
        </svg>
      )}
    </div>
  );
}
