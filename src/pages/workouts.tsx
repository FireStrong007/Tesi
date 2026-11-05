import { useState } from "react";
import { BikeIcon, DumbbellIcon, FootprintsIcon, MountainIcon, PersonStandingIcon, TimerIcon, Trash2Icon, WavesIcon } from "lucide-react";
import { useApp } from "@/app-context";
import { TimeChart } from "@/components/charts/charts";
import { EmptyState, PageBody, PageHeader, Stat } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { useQuery } from "@/hooks/use-query";
import { useSize } from "@/hooks/use-size";
import { deleteWorkout, getWorkout, listWorkouts, workoutRecords, type Workout, type WorkoutRecord } from "@/lib/db/repo";
import { fmtDateTime, fmtDistance, fmtDuration, fmtInt, fmtPace, fmt1 } from "@/lib/format";
import { navigate } from "@/lib/router";
import { sportName } from "@/lib/sports";

export function SportIcon({ sport, className }: { sport: number | null; className?: string }) {
  const I = sport === 1 ? PersonStandingIcon : sport === 2 || sport === 21 ? BikeIcon : sport === 5 ? WavesIcon : sport === 11 ? FootprintsIcon : sport === 17 || sport === 16 ? MountainIcon : sport === 10 || sport === 4 ? DumbbellIcon : TimerIcon;
  return <I className={className} />;
}

export function WorkoutsPage() {
  const { db, user } = useApp();
  const { data } = useQuery(() => listWorkouts(db, user.id), [user.id]);
  const groups = new Map<string, Workout[]>();
  for (const w of data ?? []) {
    const k = new Date(w.start_time * 1000).toLocaleDateString("it-IT", { month: "long", year: "numeric" });
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }
  return (
    <>
      <PageHeader title="Attività sportive" subtitle={data ? `${data.length} attività registrate` : undefined} />
      <PageBody>
        {data && data.length === 0 && (
          <EmptyState icon={<TimerIcon />} title="Nessuna attività">
            Avvia un'attività sul bracciale (corsa, camminata, bici…) e sincronizza: comparirà qui con durata, distanza e battito.
          </EmptyState>
        )}
        {[...groups.entries()].map(([month, list]) => (
          <section key={month} className="space-y-2">
            <h2 className="text-muted-foreground px-1 text-sm font-medium capitalize">{month}</h2>
            <Card className="gap-0 py-0">
              {list.map((w, i) => (
                <button key={w.id} onClick={() => navigate(`/workouts/${w.id}`)} className={`hover:bg-accent/40 flex w-full items-center gap-3 px-4 py-3 text-left ${i ? "border-t" : ""}`}>
                  <div className="bg-accent text-accent-foreground flex size-10 shrink-0 items-center justify-center rounded-full">
                    <SportIcon sport={w.sport} className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{sportName(w.sport, w.name)}</div>
                    <div className="text-muted-foreground truncate text-xs">{fmtDateTime(w.start_time)}</div>
                  </div>
                  <div className="text-right text-sm">
                    <div className="tabular font-medium">{w.distance_m ? fmtDistance(w.distance_m) : fmtDuration(w.timer_s ?? w.elapsed_s)}</div>
                    <div className="text-muted-foreground tabular text-xs">
                      {fmtDuration(w.timer_s ?? w.elapsed_s)} {w.avg_hr ? `· ${w.avg_hr} bpm` : ""}
                    </div>
                  </div>
                </button>
              ))}
            </Card>
          </section>
        ))}
      </PageBody>
    </>
  );
}

export function WorkoutDetailPage({ id }: { id: number }) {
  const { db, bumpData } = useApp();
  const { data: w } = useQuery(() => getWorkout(db, id), [id]);
  const { data: recs } = useQuery(() => workoutRecords(db, id), [id]);
  const [confirm, setConfirm] = useState(false);
  if (!w) return <PageHeader title="Attività" back={() => navigate("/workouts")} />;
  const hr = (recs ?? []).filter((r) => r.heart_rate).map((r) => ({ timestamp: r.timestamp, value: r.heart_rate! }));
  const speed = (recs ?? []).filter((r) => r.speed).map((r) => ({ timestamp: r.timestamp, value: r.speed! * 3.6 }));
  const alt = (recs ?? []).filter((r) => r.altitude != null).map((r) => ({ timestamp: r.timestamp, value: r.altitude! }));
  const track = (recs ?? []).filter((r) => r.lat != null && r.lon != null);
  const isRun = w.sport === 1 || w.sport === 11 || w.sport === 17;

  return (
    <>
      <PageHeader
        title={sportName(w.sport, w.name)}
        subtitle={fmtDateTime(w.start_time)}
        back={() => navigate("/workouts")}
        actions={
          <Button variant="ghost" size="icon" aria-label="Elimina" onClick={() => setConfirm(true)}>
            <Trash2Icon />
          </Button>
        }
      />
      <PageBody>
        <Card className="py-4">
          <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Durata" value={fmtDuration(w.timer_s ?? w.elapsed_s)} />
            <Stat label="Distanza" value={w.distance_m ? fmtDistance(w.distance_m) : "–"} />
            <Stat label={isRun ? "Passo medio" : "Velocità media"} value={isRun ? fmtPace(w.avg_speed) : `${fmt1((w.avg_speed ?? 0) * 3.6)} km/h`} />
            <Stat label="Calorie" value={fmtInt(w.calories)} unit="kcal" />
            <Stat label="Battito medio" value={fmtInt(w.avg_hr)} unit="bpm" />
            <Stat label="Battito max" value={fmtInt(w.max_hr)} unit="bpm" />
            <Stat label="Salita" value={fmtInt(w.ascent_m)} unit="m" />
            <Stat label="Discesa" value={fmtInt(w.descent_m)} unit="m" />
          </CardContent>
        </Card>
        {track.length > 1 && (
          <Card className="gap-3 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-base">Percorso</CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              <Route points={track} />
            </CardContent>
          </Card>
        )}
        {hr.length > 0 && (
          <Card className="gap-3 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-base">Frequenza cardiaca</CardTitle>
            </CardHeader>
            <CardContent className="px-3">
              <TimeChart from={w.start_time} to={w.end_time} series={[{ points: hr, color: "var(--heart)", area: true, gap: 120, label: "bpm" }]} />
            </CardContent>
          </Card>
        )}
        {speed.length > 0 && (
          <Card className="gap-3 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-base">Velocità</CardTitle>
            </CardHeader>
            <CardContent className="px-3">
              <TimeChart from={w.start_time} to={w.end_time} yMin={0} format={(v) => fmt1(v)} series={[{ points: speed, color: "var(--primary)", gap: 120, label: "km/h" }]} />
            </CardContent>
          </Card>
        )}
        {alt.length > 0 && (
          <Card className="gap-3 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-base">Altitudine</CardTitle>
            </CardHeader>
            <CardContent className="px-3">
              <TimeChart from={w.start_time} to={w.end_time} height={120} series={[{ points: alt, color: "var(--resp)", area: true, gap: 120, label: "m" }]} />
            </CardContent>
          </Card>
        )}
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
