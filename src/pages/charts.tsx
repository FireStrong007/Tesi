/**
 * Grafici: one page per metric, inspired by Gadgetbridge's chart screens (summary gauge, tiles per
 * category, day/week/month charts) but laid out for both screens: on a phone everything stacks like
 * the app, on a computer the summary sits next to the charts.
 */
import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import {
  ActivityIcon,
  BarChart3Icon,
  BatteryChargingIcon,
  BrainIcon,
  DropletIcon,
  FlameIcon,
  FootprintsIcon,
  HeartPulseIcon,
  MoonIcon,
  WavesIcon,
  WindIcon,
  ZapIcon,
} from "lucide-react";
import { useApp } from "@/app-context";
import {
  ActivitySleepChart,
  ArcGauge,
  BarChart,
  GoalRing,
  Hypnogram,
  Legend,
  STAGE_COLOR,
  SegmentRing,
  TimeChart,
  niceAxisMax,
  type BarItem,
  type Overlay,
} from "@/components/charts/charts";
import { DateNav, EmptyState, PageBody, PageHeader, periodRange, type Period } from "@/components/page";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useQuery } from "@/hooks/use-query";
import { loadDay, type DayData } from "@/lib/day-data";
import { sleepTotal, startOfDay, type User } from "@/lib/db/repo";
import { fmtDay, fmtDayLong, fmtDayNum, fmtDistance, fmtInt, fmtMinutes, fmtTime, fmtWeekday, fmt1 } from "@/lib/format";
import { STRESS_LEVELS, STRESS_MIN_VALID, estimateBmr, remaining, restingCalories, sleepDebt, stats, stressLevelOf, type StressKey } from "@/lib/metrics";
import { loadRange, type DayAgg, type RangeData } from "@/lib/range-data";
import { navigate, query, usePath } from "@/lib/router";
import { cn } from "@/lib/utils";
import { stressLabel } from "./dashboard";

type Icon = ComponentType<{ className?: string }>;
const METRICS: { id: string; label: string; icon: Icon; color: string; periods: Period[] }[] = [
  { id: "activity", label: "Attività e sonno", icon: ActivityIcon, color: "var(--primary)", periods: ["day"] },
  { id: "steps", label: "Passi", icon: FootprintsIcon, color: "var(--steps)", periods: ["day", "week", "month"] },
  { id: "calories", label: "Calorie", icon: FlameIcon, color: "var(--calories)", periods: ["day", "week", "month"] },
  { id: "sleep", label: "Sonno", icon: MoonIcon, color: "var(--sleep-deep)", periods: ["day", "week", "month"] },
  { id: "hr", label: "Battito", icon: HeartPulseIcon, color: "var(--heart)", periods: ["day", "week", "month"] },
  { id: "stress", label: "Stress", icon: BrainIcon, color: "var(--stress)", periods: ["day", "week", "month"] },
  { id: "energy", label: "Body Battery", icon: BatteryChargingIcon, color: "var(--energy)", periods: ["day", "week", "month"] },
  { id: "spo2", label: "SpO₂", icon: DropletIcon, color: "var(--spo2)", periods: ["day", "week", "month"] },
  { id: "resp", label: "Respirazione", icon: WindIcon, color: "var(--resp)", periods: ["day", "week", "month"] },
  { id: "hrv", label: "HRV", icon: WavesIcon, color: "var(--hrv)", periods: ["week", "month"] },
  { id: "intensity", label: "Intensità", icon: ZapIcon, color: "var(--calories)", periods: ["week", "month"] },
];
type MetricId = string;

const PERIOD_LABEL: Record<Period, string> = { day: "Giorno", week: "Settimana", month: "Mese" };

export function ChartsPage() {
  const path = usePath();
  const q = query(path);
  const tab: MetricId = METRICS.some((m) => m.id === q.get("tab")) ? q.get("tab")! : "activity";
  const day = Number(q.get("day")) || startOfDay(Date.now() / 1000);
  const metric = METRICS.find((m) => m.id === tab)!;
  const asked = q.get("period") as Period | null;
  const period: Period = asked && metric.periods.includes(asked) ? asked : metric.periods[0];
  const set = (p: Record<string, string | number>) => {
    const n = new URLSearchParams({ tab, day: String(day), period });
    for (const [k, v] of Object.entries(p)) n.set(k, String(v));
    navigate(`/charts?${n.toString()}`, true);
  };
  const openDay = (d: number) => set({ day: d, period: "day" });

  return (
    <>
      <PageHeader title="Grafici" subtitle={metric.label} wide />
      {/* metric picker: scrolls on a phone, wraps on a computer */}
      <div className="bg-background/90 sticky top-[57px] z-20 border-b backdrop-blur md:static md:border-0 md:bg-transparent md:backdrop-blur-none">
        <nav className="mx-auto max-w-7xl overflow-x-auto px-4 [scrollbar-width:none] md:overflow-visible md:px-8" aria-label="Metriche">
          <div className="flex w-max gap-1.5 py-2 md:w-auto md:flex-wrap">
            {METRICS.map((m) => {
              const active = m.id === tab;
              return (
                <button
                  key={m.id}
                  onClick={() => set({ tab: m.id })}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                    active ? "bg-foreground text-background border-foreground" : "bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  <m.icon className="size-4" />
                  {m.label}
                </button>
              );
            })}
          </div>
        </nav>
      </div>
      <PageBody wide>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          {metric.periods.length > 1 ? (
            <ToggleGroup type="single" value={period} onValueChange={(v) => v && set({ period: v })} className="w-full lg:w-auto">
              {metric.periods.map((p) => (
                <ToggleGroupItem key={p} value={p} className="lg:px-5">
                  {PERIOD_LABEL[p]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : (
            <div />
          )}
          <div className="w-full lg:w-auto lg:min-w-[520px]">
            <DateNav day={day} onChange={(d) => set({ day: d })} period={period} />
          </div>
        </div>
        {period === "day" ? <DayView tab={tab} day={day} /> : <RangeView tab={tab} day={day} period={period} onOpenDay={openDay} />}
      </PageBody>
    </>
  );
}

// ------------------------------------------------------------------ layout pieces

/** Summary on the left (computer) or on top (phone), charts on the right / below. */
function MetricLayout({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
      <div className="xl:sticky xl:top-4">{summary}</div>
      <div className="min-w-0 space-y-4">{children}</div>
    </div>
  );
}

function SummaryCard({ title, subtitle, gauge, children, note }: { title: ReactNode; subtitle?: ReactNode; gauge?: ReactNode; children?: ReactNode; note?: ReactNode }) {
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="px-5 text-center xl:text-left">
        <CardTitle className="text-base capitalize">{title}</CardTitle>
        {subtitle && <CardDescription>{subtitle}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        {gauge && <div className="flex justify-center">{gauge}</div>}
        {children}
        {note && <p className="text-muted-foreground text-xs">{note}</p>}
      </CardContent>
    </Card>
  );
}

interface TileSpec {
  label: string;
  value: ReactNode;
  unit?: string;
  color?: string;
  sub?: ReactNode;
}

function Tiles({ items, cols = 2 }: { items: TileSpec[]; cols?: 2 | 3 | 4 }) {
  return (
    <div className={cn("grid gap-2", cols === 2 ? "grid-cols-2" : cols === 3 ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-4")}>
      {items.map((t) => (
        <div key={t.label} className="bg-muted/40 relative min-w-0 overflow-hidden rounded-lg border px-3 py-2.5">
          {t.color && <span className="absolute inset-y-0 left-0 w-1" style={{ background: t.color }} />}
          <div className="tabular truncate text-lg leading-tight font-semibold">
            {t.value}
            {t.unit && <span className="text-muted-foreground ml-1 text-xs font-normal">{t.unit}</span>}
          </div>
          <div className="text-muted-foreground truncate text-xs">{t.label}</div>
          {t.sub && <div className="text-muted-foreground mt-0.5 truncate text-[11px]">{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function ChartCard({ title, description, action, children }: { title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <div className="col-start-2 row-span-2 row-start-1 self-start justify-self-end">{action}</div>}
      </CardHeader>
      <CardContent className="space-y-3 px-3 sm:px-4">{children}</CardContent>
    </Card>
  );
}

function BigValue({ value, unit, label, icon, color }: { value: ReactNode; unit?: string; label?: string; icon?: ReactNode; color?: string }) {
  return (
    <div className="flex flex-col items-center py-2 text-center">
      {icon && (
        <span className="mb-1 [&_svg]:size-6" style={{ color }}>
          {icon}
        </span>
      )}
      <div className="tabular text-4xl font-semibold">
        {value}
        {unit && <span className="text-muted-foreground ml-1 text-base font-normal">{unit}</span>}
      </div>
      {label && <div className="text-muted-foreground text-sm">{label}</div>}
    </div>
  );
}

const Center = ({ value, label, sub }: { value: ReactNode; label?: ReactNode; sub?: ReactNode }) => (
  <>
    <div className={cn("tabular leading-tight font-semibold", String(value).length > 6 ? "text-2xl" : "text-3xl")}>{value}</div>
    {label && <div className="text-muted-foreground text-xs">{label}</div>}
    {sub && <div className="text-muted-foreground text-[11px]">{sub}</div>}
  </>
);

const NoData = ({ children }: { children?: ReactNode }) => (
  <EmptyState icon={<BarChart3Icon />} title="Nessun dato">
    {children ?? "Non ci sono dati per questo periodo. Sincronizza il bracciale, importa da Gadgetbridge oppure scegli un altro giorno."}
  </EmptyState>
);

const Loading = () => (
  <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
    <div className="bg-muted h-80 animate-pulse rounded-xl" />
    <div className="bg-muted h-80 animate-pulse rounded-xl" />
  </div>
);

const stageMinutes = (m: { deep: number; light: number; rem: number; awake: number }) => [
  { label: "Profondo", value: m.deep, color: STAGE_COLOR[3] },
  { label: "Leggero", value: m.light, color: STAGE_COLOR[2] },
  { label: "REM", value: m.rem, color: STAGE_COLOR[4] },
  { label: "Sveglio", value: m.awake, color: STAGE_COLOR[1] },
];

const sleepBand = (d: DayData) => (d.sleep ? [{ start: d.sleep.start, end: d.sleep.end, color: "color-mix(in oklch, var(--sleep-light) 12%, transparent)" }] : []);

function bmrOf(rmr: number | null, user: User) {
  if (rmr) return { value: rmr, estimated: false };
  const e = estimateBmr(user);
  return { value: e, estimated: e !== null };
}

// ------------------------------------------------------------------ day

function DayView({ tab, day }: { tab: MetricId; day: number }) {
  const { db, user } = useApp();
  const { data: d } = useQuery(() => loadDay(db, user.id, day), [day, user.id]);
  if (!d) return <Loading />;
  if (!d.hasData) return <NoData />;
  const dateTitle = fmtDayLong(day);

  switch (tab) {
    case "activity":
      return (
        <MetricLayout
          summary={
            <SummaryCard title={dateTitle} gauge={<GoalRing value={d.steps} goal={user.step_goal} color="var(--steps)" size={170} stroke={14}><Center value={fmtInt(d.steps)} label={`di ${fmtInt(user.step_goal)} passi`} /></GoalRing>}>
              <Tiles
                items={[
                  { label: "Distanza", value: fmtDistance(d.distanceM), color: "var(--steps)" },
                  { label: "Sonno", value: d.sleep ? fmtMinutes(d.sleepMinutes) : "–", color: STAGE_COLOR[3] },
                  { label: "Battito medio", value: fmtInt(d.hrAvg), unit: "bpm", color: "var(--heart)" },
                  { label: "Minuti attivi", value: fmtInt(d.activeMinutes), color: "var(--calories)" },
                ]}
              />
            </SummaryCard>
          }
        >
          <ChartCard title="Attività e sonno" description="Movimento e fasi del sonno ogni 5 minuti, con il battito">
            <ActivitySleepChart slots={d.slots} hr={d.hr} from={d.from} to={d.to} height={240} />
            <Legend
              items={[
                { label: "Attività", color: "var(--steps)" },
                { label: "Attività intensa", color: "var(--calories)" },
                { label: "Leggero", color: STAGE_COLOR[2] },
                { label: "Profondo", color: STAGE_COLOR[3] },
                { label: "REM", color: STAGE_COLOR[4] },
                { label: "Sveglio", color: STAGE_COLOR[1] },
                { label: "Non indossato", color: "var(--muted-foreground)" },
                { label: "Battito", color: "var(--heart)" },
              ]}
            />
          </ChartCard>
        </MetricLayout>
      );

    case "steps": {
      const goal = user.step_goal;
      const missing = remaining(goal, 1, d.steps);
      const hours: BarItem[] = Array.from({ length: 24 }, (_, h) => {
        const t0 = d.from + h * 3600;
        const v = d.samples.filter((s) => s.timestamp >= t0 && s.timestamp < t0 + 3600).reduce((s, r) => s + r.steps, 0);
        return { key: h, label: String(h).padStart(2, "0"), value: v, color: "var(--steps)" };
      });
      return (
        <MetricLayout
          summary={
            <SummaryCard
              title={dateTitle}
              subtitle={missing ? `Passi mancanti: ${fmtInt(missing)}` : "Obiettivo raggiunto"}
              gauge={
                <GoalRing value={d.steps} goal={goal} color="var(--steps)" size={180} stroke={14}>
                  <Center value={fmtInt(d.steps)} label={`obiettivo ${fmtInt(goal)}`} sub={`${Math.round((d.steps / goal) * 100)}%`} />
                </GoalRing>
              }
            >
              <Tiles
                items={[
                  { label: "Passi", value: fmtInt(d.steps), color: "var(--steps)" },
                  { label: "Distanza", value: fmtDistance(d.distanceM), color: "var(--steps)" },
                  { label: "Minuti attivi", value: fmtInt(d.activeMinutes) },
                  { label: "Calorie attive", value: fmtInt(d.activeCalories), unit: "kcal" },
                ]}
              />
            </SummaryCard>
          }
        >
          <ChartCard title="Passi durante il giorno" description="Totale progressivo; la linea tratteggiata è l'obiettivo">
            <TimeChart
              from={d.from}
              to={d.to}
              yMin={0}
              yMax={niceAxisMax(Math.max(goal, d.steps) * 1.05)}
              height={230}
              format={(v) => (v >= 1000 ? `${fmt1(v / 1000)}k` : fmtInt(v))}
              series={[{ points: d.stepsCumulative, color: "var(--steps)", area: true, kind: "step", label: "passi" }]}
              refLines={[{ value: goal, color: "var(--goal)", label: "Obiettivo" }]}
            />
          </ChartCard>
          <ChartCard title="Passi per ora">
            <BarChart items={hours} labelEvery={3} format={(v) => fmtInt(v)} height={180} />
          </ChartCard>
        </MetricLayout>
      );
    }

    case "calories": {
      const bmr = bmrOf(d.rmr, user);
      const resting = restingCalories(bmr.value, d.from, d.to);
      const goal = user.calories_goal;
      return (
        <MetricLayout
          summary={
            <SummaryCard
              title={dateTitle}
              subtitle={remaining(goal, 1, d.activeCalories) ? `Sotto l'obiettivo attivo: ${fmtInt(remaining(goal, 1, d.activeCalories))} kcal` : "Obiettivo attivo raggiunto"}
              gauge={
                <SegmentRing
                  size={180}
                  segments={[
                    { value: d.activeCalories, color: "var(--calories)", label: "Attive" },
                    { value: resting, color: "var(--rmr)", label: "A riposo" },
                  ]}
                >
                  <Center value={fmtInt(d.activeCalories + resting)} label="kcal bruciate" />
                </SegmentRing>
              }
              note={bmr.estimated ? "Il bracciale non ha indicato il metabolismo basale: è stimato da peso, altezza ed età del profilo." : !bmr.value ? "Per le calorie a riposo serve il metabolismo basale: il bracciale lo invia con la sincronizzazione, oppure compila peso, altezza e data di nascita nel profilo." : undefined}
            >
              <Tiles
                items={[
                  { label: "Attive", value: fmtInt(d.activeCalories), unit: "kcal", color: "var(--calories)" },
                  { label: "A riposo", value: bmr.value ? fmtInt(resting) : "–", unit: "kcal", color: "var(--rmr)" },
                  { label: "Obiettivo attivo", value: fmtInt(goal), unit: "kcal" },
                  { label: "Metabolismo basale", value: fmtInt(bmr.value), unit: "kcal/g" },
                ]}
              />
            </SummaryCard>
          }
        >
          <ChartCard title="Calorie attive durante il giorno" description="Totale progressivo; la linea tratteggiata è l'obiettivo">
            <TimeChart
              from={d.from}
              to={d.to}
              yMin={0}
              yMax={niceAxisMax(Math.max(goal, d.activeCalories) * 1.05)}
              height={240}
              series={[{ points: d.caloriesCumulative, color: "var(--calories)", area: true, kind: "step", label: "kcal" }]}
              refLines={[{ value: goal, color: "var(--goal)", label: "Obiettivo" }]}
            />
          </ChartCard>
        </MetricLayout>
      );
    }

    case "sleep":
      return <SleepDay d={d} goal={user.sleep_goal_min} />;

    case "hr":
      return (
        <MetricLayout
          summary={
            <SummaryCard title={dateTitle} gauge={<BigValue value={fmtInt(d.restingHr)} unit="bpm" label="a riposo" icon={<HeartPulseIcon />} color="var(--heart)" />}>
              <Tiles
                items={[
                  { label: "Minimo", value: fmtInt(d.hrMin), unit: "bpm", color: "var(--heart)" },
                  { label: "Massimo", value: fmtInt(d.hrMax), unit: "bpm", color: "var(--heart)" },
                  { label: "Media", value: fmtInt(d.hrAvg), unit: "bpm" },
                  { label: "Nel sonno", value: fmtInt(d.sleepHrStats.avg), unit: "bpm", sub: d.sleepHrStats.min != null ? `min ${d.sleepHrStats.min}` : undefined },
                ]}
              />
            </SummaryCard>
          }
        >
          <ChartCard title="Frequenza cardiaca" description="La fascia chiara è il sonno, la linea tratteggiata il battito a riposo">
            <TimeChart
              from={d.from}
              to={d.to}
              height={260}
              yMin={40}
              series={[{ points: d.hr, color: "var(--heart)", label: "bpm", gap: 1800 }]}
              refLines={d.restingHr ? [{ value: d.restingHr, color: "var(--muted-foreground)", label: "Riposo" }] : []}
              bands={sleepBand(d)}
            />
          </ChartCard>
        </MetricLayout>
      );

    case "stress": {
      const m = d.stressByLevel;
      return (
        <MetricLayout
          summary={
            <SummaryCard
              title={dateTitle}
              subtitle={stressLabel(d.stressAvg)}
              gauge={
                <SegmentRing size={180} segments={STRESS_LEVELS.map((l) => ({ value: m[l.key], color: l.color, label: l.label }))}>
                  <Center value={fmtInt(d.stressAvg)} label="media" />
                </SegmentRing>
              }
            >
              <StressTiles m={m} />
            </SummaryCard>
          }
        >
          <ChartCard title="Livello di stress" description="Ogni barra è una misura; il colore indica la fascia">
            <TimeChart
              from={d.from}
              to={d.to}
              height={260}
              yMin={0}
              yMax={100}
              series={[{ points: d.stress.filter((s) => s.value >= STRESS_MIN_VALID), color: "var(--stress)", kind: "bars", gap: 300, colorOf: (v) => stressLevelOf(v).color, label: "" }]}
              refLines={d.stressAvg != null ? [{ value: d.stressAvg, color: "var(--muted-foreground)", label: "Media" }] : []}
            />
            <Legend items={STRESS_LEVELS.map((l, i) => ({ label: `${l.label} ${i ? STRESS_LEVELS[i - 1].max + 1 : 1}–${l.max}`, color: l.color }))} />
          </ChartCard>
        </MetricLayout>
      );
    }

    case "energy":
      return (
        <MetricLayout
          summary={
            <SummaryCard
              title={dateTitle}
              gauge={
                <ArcGauge value={d.energyNow} color="var(--energy)" size={180}>
                  <Center value={fmtInt(d.energyNow)} label="su 100" />
                </ArcGauge>
              }
            >
              <Tiles
                items={[
                  { label: "Acquisita", value: `+${d.energyCharged}`, color: "var(--steps)" },
                  { label: "Persa", value: `−${d.energyDrained}`, color: "var(--stress-high)" },
                  { label: "Massimo", value: fmtInt(d.energyMax) },
                  { label: "Minimo", value: fmtInt(d.energyMin) },
                ]}
              />
            </SummaryCard>
          }
        >
          <ChartCard title="Body Battery durante il giorno" description="Sale mentre riposi, scende con attività e stress. La fascia chiara è il sonno">
            <TimeChart from={d.from} to={d.to} yMin={0} yMax={100} height={260} series={[{ points: d.energy, color: "var(--energy)", area: true, gap: 1800, label: "" }]} bands={sleepBand(d)} />
          </ChartCard>
        </MetricLayout>
      );

    case "spo2": {
      const s = stats(d.spo2.map((p) => p.value));
      if (!d.spo2.length)
        return (
          <NoData>
            Il bracciale non ha registrato la saturazione per questa notte. Sul vívosmart 5 la misura notturna va attivata nelle impostazioni del pulsossimetro, e consuma più batteria.
          </NoData>
        );
      return (
        <MetricLayout
          summary={
            <SummaryCard title={dateTitle} gauge={<BigValue value={fmtInt(s.avg)} unit="%" label="media" icon={<DropletIcon />} color="var(--spo2)" />}>
              <Tiles items={[{ label: "Minima", value: fmtInt(s.min), unit: "%", color: "var(--spo2)" }, { label: "Massima", value: fmtInt(s.max), unit: "%" }, { label: "Letture", value: d.spo2.length }]} cols={3} />
            </SummaryCard>
          }
        >
          <ChartCard title="Saturazione (SpO₂)">
            <TimeChart from={d.from - 6 * 3600} to={d.to} yMin={80} yMax={100} height={240} series={[{ points: d.spo2, color: "var(--spo2)", dots: true, gap: 3600, label: "%" }]} />
          </ChartCard>
        </MetricLayout>
      );
    }

    case "resp": {
      const all = stats(d.resp.map((p) => p.value));
      const night = stats(d.sleepResp.map((p) => p.value));
      return (
        <MetricLayout
          summary={
            <SummaryCard title={dateTitle} gauge={<BigValue value={fmt1(d.respAvg)} unit="resp/min" label="media del giorno" icon={<WindIcon />} color="var(--resp)" />}>
              <Tiles
                items={[
                  { label: "Nel sonno", value: fmt1(night.avg), unit: "resp/min", color: STAGE_COLOR[3] },
                  { label: "Minima", value: fmt1(all.min), color: "var(--resp)" },
                  { label: "Massima", value: fmt1(all.max) },
                  { label: "Letture", value: fmtInt(d.resp.length) },
                ]}
              />
            </SummaryCard>
          }
        >
          <ChartCard title="Frequenza respiratoria" description="La fascia chiara è il sonno">
            <TimeChart from={d.from} to={d.to} yMin={8} yMax={25} height={240} format={(v) => fmt1(v)} series={[{ points: d.resp, color: "var(--resp)", gap: 3600, label: "resp/min" }]} bands={sleepBand(d)} />
          </ChartCard>
        </MetricLayout>
      );
    }

    default:
      return <NoData />;
  }
}

function StressTiles({ m }: { m: Record<StressKey, number> }) {
  return <Tiles items={STRESS_LEVELS.map((l) => ({ label: l.label, value: fmtMinutes(m[l.key]), color: l.color }))} />;
}

const OVERLAYS = [
  { id: "hr", label: "Battito", icon: HeartPulseIcon, color: "var(--heart)", unit: "bpm" },
  { id: "spo2", label: "Ossigenazione", icon: DropletIcon, color: "var(--spo2)", unit: "%" },
  { id: "resp", label: "Respirazione", icon: WindIcon, color: "var(--resp)", unit: "resp/min" },
] as const;

function SleepDay({ d, goal }: { d: DayData; goal: number }) {
  const [overlayId, setOverlayId] = useState<"hr" | "spo2" | "resp" | null>("hr");
  const s = d.sleep;
  if (!s) return <NoData>Nessun sonno registrato per questa notte.</NoData>;
  const total = sleepTotal(s);
  const points = { hr: d.sleepHr, spo2: d.sleepSpo2, resp: d.sleepResp };
  const ov = OVERLAYS.find((o) => o.id === overlayId);
  const overlay: Overlay | null = ov && points[ov.id].length ? { points: points[ov.id], color: ov.color, label: ov.label, unit: ov.unit } : null;
  const debt = Math.max(0, goal - total);
  return (
    <MetricLayout
      summary={
        <SummaryCard
          title={fmtDayLong(s.day)}
          subtitle={`${fmtTime(s.start)} – ${fmtTime(s.end)}`}
          gauge={
            <SegmentRing size={190} segments={stageMinutes(s.minutes)}>
              <Center value={fmtMinutes(total)} label={s.score != null ? `Punteggio ${s.score}` : undefined} sub={debt ? `${fmtMinutes(debt)} sotto l'obiettivo` : "Obiettivo raggiunto"} />
            </SegmentRing>
          }
        >
          <Tiles items={stageMinutes(s.minutes).map((x) => ({ label: x.label, value: fmtMinutes(x.value), color: x.color, sub: total ? `${Math.round((x.value / (total + s.minutes.awake)) * 100)}%` : undefined }))} />
        </SummaryCard>
      }
    >
      <ChartCard
        title="Fasi del sonno"
        description="Scegli cosa sovrapporre alle fasi"
        action={
          <div className="flex flex-wrap justify-end gap-1">
            {OVERLAYS.map((o) => {
              const has = points[o.id].length > 0;
              const on = overlayId === o.id;
              return (
                <button
                  key={o.id}
                  disabled={!has}
                  onClick={() => setOverlayId(on ? null : o.id)}
                  title={has ? undefined : "Nessun dato per questa notte"}
                  className={cn(
                    "flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40",
                    on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                  style={on ? { borderColor: o.color, background: `color-mix(in oklch, ${o.color} 14%, transparent)` } : undefined}
                >
                  <o.icon className="size-3.5" />
                  <span className="hidden sm:inline">{o.label}</span>
                </button>
              );
            })}
          </div>
        }
      >
        <Hypnogram segments={s.segments} from={s.start} to={s.end} height={220} overlay={overlay} />
        <Legend items={[...stageMinutes(s.minutes).map((x) => ({ label: x.label, color: x.color })), ...(overlay ? [{ label: overlay.label, color: overlay.color }] : [])]} />
      </ChartCard>
      <Card className="py-4">
        <CardContent className="px-4">
          <Tiles
            cols={4}
            items={[
              { label: "Battito minimo", value: fmtInt(d.sleepHrStats.min), unit: "bpm", color: "var(--heart)" },
              { label: "Battito massimo", value: fmtInt(d.sleepHrStats.max), unit: "bpm", color: "var(--heart)" },
              { label: "Battito medio", value: fmtInt(d.sleepHrStats.avg), unit: "bpm", color: "var(--heart)" },
              { label: "Momenti di irrequietezza", value: fmtInt(d.restlessMoments), color: STAGE_COLOR[1] },
            ]}
          />
        </CardContent>
      </Card>
    </MetricLayout>
  );
}

// ------------------------------------------------------------------ week / month

function RangeView({ tab, day, period, onOpenDay }: { tab: MetricId; day: number; period: Period; onOpenDay: (d: number) => void }) {
  const { db, user } = useApp();
  const { from, to } = periodRange(period, day);
  const { data: r } = useQuery(() => loadRange(db, user.id, from, to), [from, to, user.id]);
  const labelOf = (d: number) => (period === "week" ? fmtWeekday(d).toUpperCase() : fmtDayNum(d));
  const common = {
    labelEvery: period === "month" ? 5 : 1,
    onSelect: (k: string | number) => onOpenDay(Number(k)),
    showValues: period === "week",
    height: 260,
  };
  const title = `${fmtDay(from)} – ${fmtDay(addDaysLocal(to, -1))}`;
  const view = useMemo(() => (r ? buildRange(tab, r, user, labelOf) : null), [r, tab, user, period]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r || !view) return <Loading />;
  if (!view.hasData) return <NoData />;
  return (
    <MetricLayout
      summary={
        <SummaryCard title={title} subtitle={view.subtitle} gauge={view.gauge}>
          <Tiles items={view.tiles} />
        </SummaryCard>
      }
    >
      <ChartCard title={view.chartTitle} description="Tocca o clicca una barra per aprire quel giorno">
        <BarChart items={view.items} goal={view.goal} refLines={view.refLines} format={view.axis} valueFormat={view.valueFormat} yMin={view.yMin} yMax={view.yMax} {...common} />
        {view.legend && <Legend items={view.legend} />}
      </ChartCard>
      {view.extra}
    </MetricLayout>
  );
}

const addDaysLocal = (d: number, n: number) => {
  const x = new Date(d * 1000);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate() + n).getTime() / 1000;
};

interface RangeViewSpec {
  hasData: boolean;
  subtitle?: string;
  gauge?: ReactNode;
  tiles: TileSpec[];
  chartTitle: string;
  items: BarItem[];
  goal?: number;
  refLines?: { value: number; color: string; label?: string }[];
  axis: (v: number) => string;
  valueFormat?: (v: number) => string;
  yMin?: number;
  yMax?: number;
  legend?: { label: string; color: string }[];
  extra?: ReactNode;
}

const kFmt = (v: number) => (v >= 1000 ? `${fmt1(v / 1000)}k` : fmtInt(v));
const hFmt = (v: number) => `${Math.round(v / 60)}h`;
/** axis maximum in minutes rounded up to whole multiples of `stepMin` (readable hour ticks) */
const hourAxis = (maxMin: number, stepMin: number) => Math.max(stepMin, Math.ceil((maxMin * 1.05) / stepMin) * stepMin);
const avgOf = (vals: number[]) => (vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null);

function buildRange(tab: MetricId, r: RangeData, user: User, labelOf: (d: number) => string): RangeViewSpec {
  const n = r.days.length;
  const aggItems = (a: DayAgg[], k: "avg" | "max" | "min", color: string): BarItem[] => a.map((x) => ({ key: x.day, label: labelOf(x.day), value: x[k] ?? 0, color }));
  const minMaxItems = (a: DayAgg[], color: string, marker?: (i: number) => number | undefined): BarItem[] =>
    a.map((x, i) => ({ key: x.day, label: labelOf(x.day), value: x.max ?? 0, base: x.min ?? undefined, color, marker: marker?.(i) }));
  const summaryOf = (a: DayAgg[]) => {
    const withData = a.filter((x) => x.count);
    return {
      min: withData.length ? Math.min(...withData.map((x) => x.min!)) : null,
      max: withData.length ? Math.max(...withData.map((x) => x.max!)) : null,
      avg: withData.length ? withData.reduce((s, x) => s + x.avg! * x.count, 0) / withData.reduce((s, x) => s + x.count, 0) : null,
      days: withData.length,
    };
  };

  switch (tab) {
    case "steps": {
      const total = r.totals.reduce((s, t) => s + t.steps, 0);
      const dist = r.totals.reduce((s, t) => s + t.distance_m, 0);
      const active = r.totals.filter((t) => t.steps > 0);
      const avg = active.length ? total / active.length : 0;
      return {
        hasData: total > 0,
        subtitle: `Passi mancanti: ${fmtInt(remaining(user.step_goal, n, total))}`,
        gauge: <BigValue value={fmtInt(avg)} label="passi al giorno in media" icon={<FootprintsIcon />} color="var(--steps)" />,
        tiles: [
          { label: "Passi totali", value: fmtInt(total), color: "var(--steps)" },
          { label: "Obiettivo raggiunto", value: `${r.totals.filter((t) => t.steps >= user.step_goal).length}/${n}`, unit: "giorni" },
          { label: "Distanza media", value: fmtDistance(active.length ? dist / active.length : 0) },
          { label: "Distanza totale", value: fmtDistance(dist) },
        ],
        chartTitle: "Passi al giorno",
        items: r.totals.map((t) => ({ key: t.day, label: labelOf(t.day), value: t.steps, color: t.steps >= user.step_goal ? "var(--steps)" : "color-mix(in oklch, var(--steps) 60%, var(--muted))" })),
        goal: user.step_goal,
        refLines: avg ? [{ value: avg, color: "var(--muted-foreground)", label: "Media" }] : [],
        axis: kFmt,
        valueFormat: kFmt,
      };
    }

    case "calories": {
      const activeTot = r.totals.reduce((s, t) => s + t.calories, 0);
      const withData = r.totals.filter((t) => t.calories > 0 || t.steps > 0);
      const now = Date.now() / 1000;
      const bmrs = r.rmr.map((v) => v ?? estimateBmr(user));
      const restTot = r.days.reduce((s, d, i) => s + (withData.some((t) => t.day === d) ? restingCalories(bmrs[i], d, addDaysLocal(d, 1), now) : 0), 0);
      const lastBmr = [...bmrs].reverse().find((v) => v) ?? null;
      return {
        hasData: activeTot > 0,
        subtitle: `Sotto l'obiettivo attivo: ${fmtInt(remaining(user.calories_goal, n, activeTot))} kcal`,
        gauge: (
          <SegmentRing size={170} segments={[{ value: activeTot, color: "var(--calories)", label: "Attive" }, { value: restTot, color: "var(--rmr)", label: "A riposo" }]}>
            <Center value={fmtInt(activeTot + restTot)} label="kcal totali" />
          </SegmentRing>
        ),
        tiles: [
          { label: "Media attive", value: fmtInt(withData.length ? activeTot / withData.length : 0), unit: "kcal", color: "var(--calories)" },
          { label: "Totale attive", value: fmtInt(activeTot), unit: "kcal", color: "var(--calories)" },
          { label: "Metabolismo basale", value: fmtInt(lastBmr), unit: "kcal/g", color: "var(--rmr)" },
          { label: "Totale a riposo", value: fmtInt(restTot), unit: "kcal", color: "var(--rmr)" },
        ],
        chartTitle: "Calorie attive al giorno",
        items: r.totals.map((t) => ({ key: t.day, label: labelOf(t.day), value: t.calories, color: "var(--calories)" })),
        goal: user.calories_goal,
        axis: (v) => fmtInt(v),
      };
    }

    case "sleep": {
      const nights = r.sleep.map((s) => (s ? sleepTotal(s) : null));
      const withData = r.sleep.filter(Boolean) as NonNullable<RangeData["sleep"][number]>[];
      const avg = avgOf(nights.filter((x): x is number => x != null));
      const avgStage = (k: "deep" | "light" | "rem" | "awake") => avgOf(withData.map((s) => s.minutes[k])) ?? 0;
      const scores = r.sleep.map((s, i) => (s?.score != null ? { timestamp: r.days[i] + 12 * 3600, value: s.score } : null)).filter(Boolean) as { timestamp: number; value: number }[];
      return {
        hasData: withData.length > 0,
        subtitle: `Debito di sonno: ${fmtMinutes(sleepDebt(nights, user.sleep_goal_min))}`,
        gauge: (
          <SegmentRing size={170} segments={stageMinutes({ deep: avgStage("deep"), light: avgStage("light"), rem: avgStage("rem"), awake: avgStage("awake") })}>
            <Center value={fmtMinutes(avg)} label="media per notte" />
          </SegmentRing>
        ),
        tiles: stageMinutes({ deep: avgStage("deep"), light: avgStage("light"), rem: avgStage("rem"), awake: avgStage("awake") }).map((x) => ({ label: `${x.label} (media)`, value: fmtMinutes(x.value), color: x.color })),
        chartTitle: "Sonno per notte",
        items: r.days.map((d, i) => {
          const s = r.sleep[i];
          return {
            key: d,
            label: labelOf(d),
            value: s ? sleepTotal(s) + s.minutes.awake : 0,
            segments: s ? stageMinutes(s.minutes).map((x) => ({ value: x.value, color: x.color })) : [],
          };
        }),
        goal: user.sleep_goal_min,
        refLines: avg ? [{ value: avg, color: "var(--heart)", label: `Media ${fmtMinutes(avg)}` }] : [],
        axis: hFmt,
        yMax: hourAxis(Math.max(user.sleep_goal_min, ...withData.map((x) => sleepTotal(x) + x.minutes.awake)), 120),
        valueFormat: (v) => fmtMinutes(v),
        legend: stageMinutes({ deep: 0, light: 0, rem: 0, awake: 0 }).map((x) => ({ label: x.label, color: x.color })),
        extra: scores.length ? (
          <ChartCard title="Punteggio del sonno">
            <TimeChart from={r.days[0]} to={addDaysLocal(r.days[n - 1], 1)} yMin={0} yMax={100} height={170} xTicks="days" series={[{ points: scores, color: "var(--sleep-deep)", dots: true, label: "" }]} />
          </ChartCard>
        ) : undefined,
      };
    }

    case "hr": {
      const s = summaryOf(r.hr);
      const rest = r.resting.filter((x) => x.count).map((x) => x.min!);
      return {
        hasData: s.days > 0,
        gauge: <BigValue value={fmtInt(avgOf(rest))} unit="bpm" label="a riposo in media" icon={<HeartPulseIcon />} color="var(--heart)" />,
        tiles: [
          { label: "Minimo", value: fmtInt(s.min), unit: "bpm", color: "var(--heart)" },
          { label: "Massimo", value: fmtInt(s.max), unit: "bpm", color: "var(--heart)" },
          { label: "Media", value: fmtInt(s.avg), unit: "bpm" },
          { label: "Riposo più basso", value: fmtInt(rest.length ? Math.min(...rest) : null), unit: "bpm" },
        ],
        chartTitle: "Battito: minimo e massimo per giorno (il punto è il battito a riposo)",
        items: minMaxItems(r.hr, "color-mix(in oklch, var(--heart) 75%, transparent)", (i) => r.resting[i].min ?? undefined),
        axis: (v) => fmtInt(v),
        yMin: 40,
      };
    }

    case "stress": {
      const tot: Record<StressKey, number> = { rest: 0, low: 0, medium: 0, high: 0 };
      r.stressByLevel.forEach((m) => STRESS_LEVELS.forEach((l) => (tot[l.key] += m[l.key])));
      const s = summaryOf(r.stress);
      return {
        hasData: s.days > 0,
        subtitle: stressLabel(s.avg),
        gauge: (
          <SegmentRing size={170} segments={STRESS_LEVELS.map((l) => ({ value: tot[l.key], color: l.color, label: l.label }))}>
            <Center value={fmtInt(s.avg)} label="media" />
          </SegmentRing>
        ),
        tiles: STRESS_LEVELS.map((l) => ({ label: l.label, value: fmtMinutes(tot[l.key]), color: l.color })),
        chartTitle: "Tempo in ogni fascia di stress",
        yMax: hourAxis(Math.max(60, ...r.stressByLevel.map((m) => STRESS_LEVELS.reduce((sum, l) => sum + m[l.key], 0))), 240),
        items: r.days.map((d, i) => ({
          key: d,
          label: labelOf(d),
          value: STRESS_LEVELS.reduce((sum, l) => sum + r.stressByLevel[i][l.key], 0),
          segments: STRESS_LEVELS.map((l) => ({ value: r.stressByLevel[i][l.key], color: l.color })),
        })),
        axis: hFmt,
        valueFormat: (v) => fmtMinutes(v),
        legend: STRESS_LEVELS.map((l) => ({ label: l.label, color: l.color })),
      };
    }

    case "energy": {
      const s = summaryOf(r.energy);
      const maxes = r.energy.filter((x) => x.count).map((x) => x.max!);
      return {
        hasData: s.days > 0,
        gauge: (
          <ArcGauge value={avgOf(maxes)} color="var(--energy)" size={170}>
            <Center value={fmtInt(avgOf(maxes))} label="massimo medio" />
          </ArcGauge>
        ),
        tiles: [
          { label: "Minimo", value: fmtInt(s.min), color: "var(--stress-high)" },
          { label: "Massimo", value: fmtInt(s.max), color: "var(--steps)" },
          { label: "Media", value: fmtInt(s.avg) },
          { label: "Giorni con dati", value: s.days },
        ],
        chartTitle: "Body Battery: minimo e massimo per giorno",
        items: minMaxItems(r.energy, "var(--energy)"),
        axis: (v) => fmtInt(v),
        yMax: 100,
      };
    }

    case "spo2":
    case "resp": {
      const a = tab === "spo2" ? r.spo2 : r.resp;
      const s = summaryOf(a);
      const color = tab === "spo2" ? "var(--spo2)" : "var(--resp)";
      const unit = tab === "spo2" ? "%" : "resp/min";
      const f = tab === "spo2" ? fmtInt : fmt1;
      return {
        hasData: s.days > 0,
        gauge: <BigValue value={f(s.avg)} unit={unit} label="media" icon={tab === "spo2" ? <DropletIcon /> : <WindIcon />} color={color} />,
        tiles: [
          { label: "Minimo", value: f(s.min), unit, color },
          { label: "Massimo", value: f(s.max), unit },
          { label: "Giorni con dati", value: s.days },
        ],
        chartTitle: tab === "spo2" ? "Saturazione media per giorno" : "Respirazione media per giorno",
        items: aggItems(a, "avg", color),
        axis: (v) => fmtInt(v),
        valueFormat: f,
        yMin: tab === "spo2" ? 80 : 0,
      };
    }

    case "hrv": {
      const vals = r.hrv.map((h) => h?.last_night_average ?? 0);
      const withData = vals.filter((v) => v > 0);
      const last = [...r.hrv].reverse().find(Boolean);
      return {
        hasData: withData.length > 0,
        gauge: <BigValue value={fmtInt(avgOf(withData))} unit="ms" label="media notturna" icon={<WavesIcon />} color="var(--hrv)" />,
        tiles: [
          { label: "Media 7 giorni", value: fmtInt(last?.weekly_average), unit: "ms", color: "var(--hrv)" },
          { label: "Fascia normale", value: last?.baseline_balanced_lower != null ? `${last.baseline_balanced_lower}–${last.baseline_balanced_upper}` : "–", unit: "ms" },
        ],
        chartTitle: "HRV media notturna",
        items: r.days.map((d, i) => ({ key: d, label: labelOf(d), value: vals[i], color: "var(--hrv)" })),
        refLines: last?.baseline_balanced_lower != null ? [{ value: last.baseline_balanced_lower, color: "var(--muted-foreground)", label: "Fascia" }, { value: last.baseline_balanced_upper!, color: "var(--muted-foreground)" }] : [],
        axis: (v) => fmtInt(v),
      };
    }

    case "intensity": {
      const tot = r.intensity.reduce((s, x) => s + x.moderate + 2 * x.vigorous, 0);
      const weeklyGoal = user.active_minutes_goal;
      return {
        hasData: tot > 0,
        subtitle: `Obiettivo settimanale: ${fmtInt(weeklyGoal)} minuti`,
        gauge: (
          <GoalRing value={tot} goal={(weeklyGoal * n) / 7} color="var(--calories)" size={170} stroke={14}>
            <Center value={fmtInt(tot)} label="minuti di intensità" />
          </GoalRing>
        ),
        tiles: [
          { label: "Moderati", value: fmtInt(r.intensity.reduce((s, x) => s + x.moderate, 0)), unit: "min", color: "var(--steps)" },
          { label: "Intensi (contano doppio)", value: fmtInt(r.intensity.reduce((s, x) => s + x.vigorous, 0)), unit: "min", color: "var(--calories)" },
        ],
        chartTitle: "Minuti di intensità al giorno",
        items: r.intensity.map((x) => ({
          key: x.day,
          label: labelOf(x.day),
          value: x.moderate + 2 * x.vigorous,
          segments: [
            { value: x.moderate, color: "var(--steps)" },
            { value: 2 * x.vigorous, color: "var(--calories)" },
          ],
        })),
        goal: Math.round(weeklyGoal / 7),
        axis: (v) => fmtInt(v),
        legend: [
          { label: "Moderata", color: "var(--steps)" },
          { label: "Intensa (×2)", color: "var(--calories)" },
        ],
      };
    }

    default:
      return { hasData: false, tiles: [], chartTitle: "", items: [], axis: String };
  }
}

