import { useState, type ReactNode } from "react";
import { BatteryChargingIcon, BrainIcon, DropletIcon, FlameIcon, FootprintsIcon, HeartPulseIcon, MoonIcon, RefreshCwIcon, WavesIcon, WindIcon, ZapIcon } from "lucide-react";
import { useApp } from "@/app-context";
import { NOT_AVAILABLE, sectionMode } from "@/brand";
import { DayRing, Legend } from "@/components/charts/charts";
import { DateNav, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useQuery } from "@/hooks/use-query";
import { loadDay } from "@bridge/core/day-data";
import { estimatedLabel, fmtDateTime, fmtDistance, fmtInt, fmtMinutes, fmt1 } from "@bridge/core/format";
import { restingCalories, stressLevelOf } from "@bridge/core/metrics";
import { startOfDay } from "@bridge/core/time-zone";
import { NEVER_SHORT } from "@/lib/empty-states";
import { navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const HRV_STATUS = ["Nessuno", "Scarso", "Basso", "Sbilanciato", "Bilanciato"];

function Tile({ icon, label, color, value, unit, sub, onClick, children }: { icon: ReactNode; label: string; color: string; value: ReactNode; unit?: string; sub?: ReactNode; onClick?: () => void; children?: ReactNode }) {
  return (
    <button onClick={onClick} className="bg-card hover:bg-accent/40 flex min-w-0 flex-col gap-2 rounded-xl border p-4 text-left shadow-sm transition-colors">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full [&_svg]:size-4" style={{ background: `color-mix(in oklch, ${color} 18%, transparent)`, color }}>
          {icon}
        </span>
        <span className="truncate">{label}</span>
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

/** "Ultimo aggiornamento" and the phone's last upload: they tell why data may be missing */
export function SyncLine() {
  const { status, devices } = useApp();
  const lastUpload = devices.reduce<number | null>((m, d) => (d.last_successful_upload_at != null && (m == null || d.last_successful_upload_at > m) ? d.last_successful_upload_at : m), null);
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-live="polite">
      <span>
        Ultimo aggiornamento: <span className="text-foreground">{status.syncing ? "in corso…" : status.lastSyncAt ? fmtDateTime(status.lastSyncAt / 1000) : "mai"}</span>
      </span>
      <span>
        Ultimo invio dal telefono: <span className="text-foreground">{lastUpload ? fmtDateTime(lastUpload / 1000) : "mai"}</span>
      </span>
    </div>
  );
}

/** «Sincronizza»: downloads the newest data from the server (it does not contact the phone or the band) */
export function SyncButton() {
  const { status, sync } = useApp();
  return (
    <Button variant="outline" size="sm" onClick={() => void sync()} disabled={status.syncing}>
      <RefreshCwIcon className={cn(status.syncing && "animate-spin")} /> Sincronizza
    </Button>
  );
}

export function DashboardPage() {
  const { db, user, available, dataVersion } = useApp();
  const [day, setDay] = useState(() => startOfDay(Date.now() / 1000));
  const { data: d } = useQuery(() => loadDay(db, user.id, day), [day, user.id, dataVersion]);
  const steps = d?.steps ?? 0;
  const bmr = d?.rmr ?? null;
  const go = (tab: string) => navigate(`/charts?tab=${tab}&day=${day}`);
  /** why a tile is empty: never recorded by the band, or nothing on this day */
  const none = (k: string) => (available[k] ? "Nessun dato per questo giorno" : NEVER_SHORT);

  return (
    <>
      <PageHeader title="Home" subtitle={`Ciao ${user.name}`} actions={<SyncButton />} />
      <PageBody>
        <SyncLine />
        <DateNav day={day} onChange={setDay} compact />

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
              <MiniStat label={estimatedLabel("Distanza", d?.distanceM ?? 0, d?.distanceEstimatedM ?? 0)} value={fmtDistance(d?.distanceM ?? 0)} />
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
          <Tile icon={<FootprintsIcon />} label="Passi" color="var(--steps)" value={fmtInt(steps)} sub={available.steps ? `Obiettivo ${fmtInt(user.step_goal)}` : NEVER_SHORT} onClick={() => go("steps")}>
            <Progress value={Math.min(100, (steps / user.step_goal) * 100)} className="bg-steps/15" indicatorClassName="bg-steps" />
          </Tile>
          <Tile
            icon={<MoonIcon />}
            label="Sonno"
            color="var(--sleep-deep)"
            value={d?.sleep ? fmtMinutes(d.sleepMinutes) : "–"}
            sub={d?.sleep ? `${d.sleep.score != null ? `Punteggio ${d.sleep.score} · ` : ""}profondo ${fmtMinutes(d.sleep.minutes.deep)}` : none("sleep")}
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
          {sectionMode("resting_hr") === "shown" ? (
            <Tile icon={<HeartPulseIcon />} label="Battito" color="var(--heart)" value={fmtInt(d?.restingHr)} unit="bpm a riposo" sub={d?.hrMin ? `Min ${d.hrMin} · max ${d.hrMax} bpm` : none("hr")} onClick={() => go("hr")} />
          ) : (
            // a device without resting heart rate (Gima): the day's average
            <Tile icon={<HeartPulseIcon />} label="Battito" color="var(--heart)" value={fmtInt(d?.hrAvg)} unit="bpm medio" sub={d?.hrMin ? `Min ${d.hrMin} · max ${d.hrMax} bpm` : none("hr")} onClick={() => go("hr")} />
          )}
          {sectionMode("stress") === "shown" && (
            <Tile icon={<BrainIcon />} label="Stress" color="var(--stress)" value={fmtInt(d?.stressAvg)} unit="medio" sub={d?.stressAvg != null ? stressLabel(d.stressAvg) : none("stress")} onClick={() => go("stress")} />
          )}
          {sectionMode("stress") === "unavailable" && <Tile icon={<BrainIcon />} label="Stress" color="var(--stress)" value="–" sub={NOT_AVAILABLE} />}
          {sectionMode("energy") === "shown" && (
            <Tile icon={<BatteryChargingIcon />} label="Body Battery" color="var(--energy)" value={fmtInt(d?.energyNow)} sub={d?.energyMax != null ? `Max ${d.energyMax} · min ${d.energyMin}` : none("energy")} onClick={() => go("energy")}>
              <Progress value={d?.energyNow ?? 0} className="bg-energy/15" indicatorClassName="bg-energy" />
            </Tile>
          )}
          {sectionMode("energy") === "unavailable" && <Tile icon={<BatteryChargingIcon />} label="Body Battery" color="var(--energy)" value="–" sub={NOT_AVAILABLE} />}
          <Tile icon={<DropletIcon />} label="SpO₂" color="var(--spo2)" value={fmtInt(d?.spo2Avg)} unit="%" sub={d?.spo2Avg != null ? "Media notturna" : none("spo2")} onClick={() => go("spo2")} />
          <Tile
            icon={<WavesIcon />}
            label="HRV"
            color="var(--hrv)"
            value={fmtInt(d?.hrv?.last_night_average)}
            unit="ms"
            sub={d?.hrv ? `${HRV_STATUS[d.hrv.status ?? 0]} · media 7 gg ${fmtInt(d.hrv.weekly_average)}` : none("hrv")}
            onClick={() => go("hrv")}
          />
          <Tile icon={<WindIcon />} label="Respirazione" color="var(--resp)" value={fmt1(d?.respAvg)} unit="resp/min" sub={d?.respAvg != null ? "Media del giorno" : none("resp")} onClick={() => go("resp")} />
          {sectionMode("intensity") === "shown" && (
            <Tile
              icon={<ZapIcon />}
              label="Minuti di intensità"
              color="var(--calories)"
              value={fmtInt((d?.intensityModerate ?? 0) + 2 * (d?.intensityVigorous ?? 0))}
              sub={available.intensity ? `Moderati ${d?.intensityModerate ?? 0} · intensi ${d?.intensityVigorous ?? 0}` : NEVER_SHORT}
              onClick={() => go("intensity")}
            />
          )}
          {sectionMode("intensity") === "unavailable" && <Tile icon={<ZapIcon />} label="Minuti di intensità" color="var(--calories)" value="–" sub={NOT_AVAILABLE} />}
        </div>
        {d && !d.hasData && (
          <p className="text-muted-foreground py-2 text-center text-sm">Nessun dato per questo giorno. Il telefono invia i dati al server qualche volta al giorno: premi Sincronizza per scaricare gli ultimi.</p>
        )}
      </PageBody>
    </>
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
