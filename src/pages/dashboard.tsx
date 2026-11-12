import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIcon,
  BatteryChargingIcon,
  BrainIcon,
  DropletIcon,
  FlameIcon,
  FootprintsIcon,
  HeartPulseIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  WavesIcon,
  WindIcon,
  ZapIcon,
} from "lucide-react";
import { useApp, useLive } from "@/app-context";
import { DayRing, Legend } from "@/components/charts/charts";
import { DateNav, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useQuery } from "@/hooks/use-query";
import { loadDay } from "@/lib/day-data";
import { startOfDay } from "@/lib/db/repo";
import { fmtDistance, fmtInt, fmtMinutes, fmt1 } from "@/lib/format";
import { navigate } from "@/lib/router";
import { estimateBmr, restingCalories, stressLevelOf } from "@/lib/metrics";
import { cn } from "@/lib/utils";

const HRV_STATUS = ["Nessuno", "Scarso", "Basso", "Sbilanciato", "Bilanciato"];

function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn("relative flex size-2", className)}>
      <span className="bg-heart absolute inline-flex size-full animate-ping rounded-full opacity-60" />
      <span className="bg-heart relative inline-flex size-2 rounded-full" />
    </span>
  );
}

function Tile({ icon, label, color, value, unit, sub, onClick, children, live }: { icon: ReactNode; label: string; color: string; value: ReactNode; unit?: string; sub?: ReactNode; onClick?: () => void; children?: ReactNode; live?: boolean }) {
  return (
    <button onClick={onClick} className="bg-card hover:bg-accent/40 flex min-w-0 flex-col gap-2 rounded-xl border p-4 text-left shadow-sm transition-colors">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full [&_svg]:size-4" style={{ background: `color-mix(in oklch, ${color} 18%, transparent)`, color }}>
          {icon}
        </span>
        <span className="truncate">{label}</span>
        {live && <LiveDot className="ml-auto shrink-0" />}
      </div>
      <div className="tabular truncate text-2xl font-semibold">
        {value}
        {unit && <span className="text-muted-foreground ml-1 text-sm font-normal">{unit}</span>}
      </div>
      {sub && <div className="text-muted-foreground truncate text-xs">{sub}</div>}
      {children}
    </button>
  );
}

export function DashboardPage() {
  const { db, user, devices, manager, openDemo } = useApp();
  const live = useLive();
  const [day, setDay] = useState(() => startOfDay(Date.now() / 1000));
  const { data: d } = useQuery(() => loadDay(db, user.id, day), [day, user.id]);
  const syncing = devices.find((dev) => live.get(dev.id)?.state === "syncing" || live.get(dev.id)?.progress?.phase === "processing");
  const readyDevice = devices.find((dev) => live.get(dev.id)?.state === "ready");
  const now = useNow(5000);
  const isToday = day === startOfDay(now / 1000);
  // live values from the band (only meaningful for today)
  const liveDevice = devices.find((dev) => live.get(dev.id)?.realtime);
  const rt = isToday ? live.get(liveDevice?.id ?? -1)?.realtime ?? null : null;
  const connectedDevice = devices.find((dev) => ["ready", "syncing"].includes(live.get(dev.id)?.state ?? ""));
  const stale = rt ? now / 1000 - rt.updatedAt > 90 : false;
  // the band's own step counter is the most up to date value for today
  const steps = Math.max(d?.steps ?? 0, rt?.steps ?? 0);
  const energyNow = rt?.bodyBattery ?? d?.energyNow ?? null;
  const bmr = d?.rmr ?? estimateBmr(user);
  const go = (tab: string) => navigate(`/charts?tab=${tab}&day=${day}`);

  return (
    <>
      <PageHeader
        title="Home"
        subtitle={`Ciao ${user.name}`}
        actions={
          readyDevice && (
            <Button variant="ghost" size="icon" aria-label="Sincronizza" onClick={() => void manager.sync(readyDevice.id, true)}>
              <RefreshCwIcon />
            </Button>
          )
        }
      />
      <PageBody>
        {devices.length === 0 && (
          <Card className="border-primary/30 bg-accent/40">
            <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="flex-1">
                <div className="font-semibold">Collega il tuo Garmin vívosmart 5</div>
                <div className="text-muted-foreground text-sm">
                  I dati del bracciale vengono scaricati via Bluetooth e salvati solo in questo browser, in un database SQLite.
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => navigate("/devices?pair=1")}>
                  <PlusIcon /> Aggiungi dispositivo
                </Button>
                <Button variant="outline" onClick={() => void openDemo()}>
                  Prova la demo
                </Button>
                <Button variant="ghost" onClick={() => navigate("/settings")}>
                  Importa da Gadgetbridge
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {syncing && (
          <Card className="py-4">
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <RefreshCwIcon className="size-4 animate-spin" /> Sincronizzazione {syncing.alias || syncing.name}
                </span>
                <span className="text-muted-foreground tabular">
                  {live.get(syncing.id)?.progress?.filesDone ?? 0}/{live.get(syncing.id)?.progress?.filesTotal ?? 0} file
                </span>
              </div>
              <Progress value={progressPct(live.get(syncing.id)?.progress)} />
            </CardContent>
          </Card>
        )}

        <DateNav day={day} onChange={setDay} compact />

        {isToday && rt && (
          <Card className="border-heart/30 gap-3 py-4">
            <CardContent className="flex items-center gap-4">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
                  {stale ? <span className="bg-muted-foreground/50 size-2 rounded-full" /> : <LiveDot />}
                  In tempo reale · {rt.heartRate || rt.steps != null ? `aggiornato ${fmtAgo(rt.updatedAt, now)}` : "in attesa del bracciale…"}
                </div>
                <div className="flex items-baseline gap-2">
                  <HeartPulseIcon className={cn("text-heart size-6 self-center", !stale && rt.heartRate && "animate-pulse")} />
                  <span className="tabular text-4xl font-semibold">{rt.heartRate ?? "–"}</span>
                  <span className="text-muted-foreground text-sm">bpm</span>
                </div>
                <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {rt.steps != null && <span><b className="text-foreground tabular">{fmtInt(steps)}</b> passi</span>}
                  {rt.bodyBattery != null && <span>Body Battery <b className="text-foreground tabular">{rt.bodyBattery}</b></span>}
                  {rt.respiration != null && <span><b className="text-foreground tabular">{rt.respiration}</b> resp/min</span>}
                  {rt.spo2 != null && <span>SpO₂ <b className="text-foreground tabular">{rt.spo2}%</b></span>}
                  {rt.floorsUp != null && <span><b className="text-foreground tabular">{rt.floorsUp}</b> piani</span>}
                </div>
              </div>
              <Sparkline points={rt.hrHistory} className="h-16 w-32 shrink-0 sm:w-48" />
            </CardContent>
          </Card>
        )}
        {isToday && !rt && connectedDevice && (
          <button
            onClick={() => void manager.setLive(connectedDevice.id, true)}
            className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-2 rounded-xl border border-dashed py-2.5 text-sm"
          >
            <HeartPulseIcon className="size-4" /> Attiva i dati in tempo reale
          </button>
        )}

        <Card className="py-5">
          <CardContent className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-8">
            <button onClick={() => go("activity")} aria-label="Attività e sonno">
              <DayRing slots={d?.ring ?? []} size={196}>
                <FootprintsIcon className="text-steps mb-1 size-5" />
                <div className="tabular text-2xl font-semibold">{fmtInt(steps)}</div>
                <div className="text-muted-foreground text-xs">di {fmtInt(user.step_goal)} passi</div>
              </DayRing>
            </button>
            <div className="grid w-full flex-1 grid-cols-3 gap-4 sm:grid-cols-2">
              <MiniStat label="Distanza" value={fmtDistance(d?.distanceM ?? 0)} />
              <MiniStat label="Minuti attivi" value={fmtInt(d?.activeMinutes ?? 0)} />
              <MiniStat label="Calorie attive" value={`${fmtInt(d?.activeCalories ?? 0)} kcal`} />
              <MiniStat label="Sonno" value={d?.sleep ? fmtMinutes(d.sleepMinutes) : "–"} className="hidden sm:block" />
              <div className="col-span-3 sm:col-span-2">
                <Legend
                  items={[
                    { label: "Attivo", color: "var(--steps)" },
                    { label: "Sonno leggero", color: "var(--sleep-light)" },
                    { label: "Sonno profondo", color: "var(--sleep-deep)" },
                    { label: "Sveglio", color: "var(--sleep-awake)" },
                  ]}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          <Tile icon={<FootprintsIcon />} label="Passi" color="var(--steps)" value={fmtInt(steps)} sub={`Obiettivo ${fmtInt(user.step_goal)}`} onClick={() => go("steps")} live={rt?.steps != null}>
            <Progress value={Math.min(100, (steps / user.step_goal) * 100)} className="bg-steps/15" indicatorClassName="bg-steps" />
          </Tile>
          <Tile
            icon={<MoonIcon />}
            label="Sonno"
            color="var(--sleep-deep)"
            value={d?.sleep ? fmtMinutes(d.sleepMinutes) : "–"}
            sub={d?.sleep ? `Punteggio ${d.sleep.score ?? "–"} · profondo ${fmtMinutes(d.sleep.minutes.deep)}` : "Nessun dato"}
            onClick={() => go("sleep")}
          >
            {d?.sleep && <SleepBar m={d.sleep.minutes} />}
          </Tile>
          <Tile
            icon={<FlameIcon />}
            label="Calorie"
            color="var(--calories)"
            value={fmtInt(d?.activeCalories ?? 0)}
            unit="kcal attive"
            sub={bmr ? `${fmtInt((d?.activeCalories ?? 0) + restingCalories(bmr, day, d?.to ?? day + 86400))} kcal totali` : `Obiettivo ${fmtInt(user.calories_goal)}`}
            onClick={() => go("calories")}
          >
            <Progress value={Math.min(100, ((d?.activeCalories ?? 0) / user.calories_goal) * 100)} className="bg-calories/15" indicatorClassName="bg-calories" />
          </Tile>
          {rt?.heartRate ? (
            <Tile icon={<HeartPulseIcon />} label="Battito" color="var(--heart)" value={rt.heartRate} unit="bpm ora" sub={`A riposo ${fmtInt(rt.restingHeartRate ?? d?.restingHr)} · min ${fmtInt(d?.hrMin)} · max ${fmtInt(d?.hrMax)}`} onClick={() => go("hr")} live>
              <Sparkline points={rt.hrHistory} className="h-6 w-full" />
            </Tile>
          ) : (
            <Tile icon={<HeartPulseIcon />} label="Battito" color="var(--heart)" value={fmtInt(d?.restingHr)} unit="bpm a riposo" sub={d?.hrMin ? `Min ${d.hrMin} · max ${d.hrMax} bpm` : "Nessun dato"} onClick={() => go("hr")} />
          )}
          <Tile icon={<BrainIcon />} label="Stress" color="var(--stress)" value={fmtInt(d?.stressAvg)} unit="medio" sub={stressLabel(d?.stressAvg)} onClick={() => go("stress")} />
          <Tile
            icon={<BatteryChargingIcon />}
            label="Body Battery"
            color="var(--energy)"
            value={fmtInt(energyNow)}
            sub={d?.energyMax != null ? `Max ${d.energyMax} · min ${d.energyMin}` : rt?.bodyBattery != null ? "Valore attuale" : "Nessun dato"}
            onClick={() => go("energy")}
            live={rt?.bodyBattery != null}
          >
            <Progress value={energyNow ?? 0} className="bg-energy/15" indicatorClassName="bg-energy" />
          </Tile>
          <Tile icon={<DropletIcon />} label="SpO₂" color="var(--spo2)" value={fmtInt(rt?.spo2 ?? d?.spo2Avg)} unit="%" sub={rt?.spo2 != null ? `Ora · media notturna ${fmtInt(d?.spo2Avg)}%` : "Media notturna"} onClick={() => go("spo2")} live={rt?.spo2 != null} />
          <Tile
            icon={<WavesIcon />}
            label="HRV"
            color="var(--hrv)"
            value={fmtInt(d?.hrv?.last_night_average)}
            unit="ms"
            sub={d?.hrv ? `${HRV_STATUS[d.hrv.status ?? 0]} · media 7 gg ${fmtInt(d.hrv.weekly_average)}` : "Nessun dato"}
            onClick={() => go("hrv")}
          />
          <Tile icon={<WindIcon />} label="Respirazione" color="var(--resp)" value={rt?.respiration ?? fmt1(d?.respAvg)} unit="resp/min" sub={rt?.respiration != null ? `Ora · media del giorno ${fmt1(d?.respAvg)}` : "Media del giorno"} onClick={() => go("resp")} live={rt?.respiration != null} />
          <Tile icon={<ZapIcon />} label="Minuti di intensità" color="var(--calories)" value={fmtInt((d?.intensityModerate ?? 0) + 2 * (d?.intensityVigorous ?? 0))} sub={`Moderati ${d?.intensityModerate ?? 0} · intensi ${d?.intensityVigorous ?? 0}`} onClick={() => go("intensity")} />
          <Tile icon={<ActivityIcon />} label="Attività sportive" color="var(--primary)" value="Vedi" sub="Corse, camminate e altro" onClick={() => navigate("/workouts")} />
        </div>
        {d && !d.hasData && devices.length > 0 && (
          <p className="text-muted-foreground py-2 text-center text-sm">Nessun dato per questo giorno. Sincronizza il dispositivo per scaricare i dati.</p>
        )}
      </PageBody>
    </>
  );
}

/** current time, re-rendered every `ms` (for "updated N s ago") */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function fmtAgo(ts: number, nowMs: number) {
  const s = Math.max(0, Math.round(nowMs / 1000 - ts));
  return s < 10 ? "adesso" : s < 60 ? `${s} s fa` : `${Math.floor(s / 60)} min fa`;
}

function Sparkline({ points, className }: { points: { timestamp: number; value: number }[]; className?: string }) {
  if (points.length < 2) return <div className={className} />;
  const t0 = points[0].timestamp;
  const t1 = points[points.length - 1].timestamp || t0 + 1;
  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals) - 3;
  const hi = Math.max(...vals) + 3;
  const d = points.map((p, i) => `${i ? "L" : "M"}${(((p.timestamp - t0) / (t1 - t0 || 1)) * 100).toFixed(2)},${(100 - ((p.value - lo) / (hi - lo)) * 100).toFixed(2)}`).join("");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={className} aria-hidden>
      <path d={`${d}L100,100L0,100Z`} fill="var(--heart)" opacity={0.12} />
      <path d={d} fill="none" stroke="var(--heart)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function MiniStat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="tabular truncate font-semibold">{value}</div>
    </div>
  );
}

export function SleepBar({ m }: { m: { awake: number; light: number; deep: number; rem: number } }) {
  const total = m.awake + m.light + m.deep + m.rem || 1;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full">
      <div style={{ width: `${(m.deep / total) * 100}%`, background: "var(--sleep-deep)" }} />
      <div style={{ width: `${(m.light / total) * 100}%`, background: "var(--sleep-light)" }} />
      <div style={{ width: `${(m.rem / total) * 100}%`, background: "var(--sleep-rem)" }} />
      <div style={{ width: `${(m.awake / total) * 100}%`, background: "var(--sleep-awake)" }} />
    </div>
  );
}

export function stressLabel(v: number | null | undefined) {
  if (v == null) return "Nessun dato";
  return stressLevelOf(v).label;
}

export function progressPct(p: { phase: string; filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number } | null | undefined) {
  if (!p) return 0;
  if (p.phase === "directory") return 3;
  if (p.bytesTotal > 0 && p.phase === "download") return Math.min(100, (p.bytesDone / p.bytesTotal) * 100);
  return p.filesTotal ? (p.filesDone / p.filesTotal) * 100 : 100;
}

