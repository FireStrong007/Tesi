import type { ReactNode } from "react";
import { ArrowLeftIcon, CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { addDays, startOfDay } from "@/lib/db/repo";
import { fmtDay, fmtDayLong } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PageHeader({ title, subtitle, back, actions, wide }: { title: ReactNode; subtitle?: ReactNode; back?: () => void; actions?: ReactNode; wide?: boolean }) {
  return (
    <header className="bg-background/90 sticky top-0 z-30 border-b backdrop-blur md:static md:border-0 md:bg-transparent md:backdrop-blur-none">
      <div className={cn("mx-auto flex items-center gap-2 px-4 py-3 md:px-8 md:pt-8 md:pb-2", wide ? "max-w-7xl" : "max-w-5xl")}>
        {back && (
          <Button variant="ghost" size="icon" onClick={back} aria-label="Indietro" className="-ml-2">
            <ArrowLeftIcon />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold md:text-2xl">{title}</h1>
          {subtitle && <div className="text-muted-foreground truncate text-sm">{subtitle}</div>}
        </div>
        {actions && <div className="flex items-center gap-1">{actions}</div>}
      </div>
    </header>
  );
}

export function PageBody({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <main className={cn("mx-auto space-y-4 px-4 py-4 md:px-8", wide ? "max-w-7xl" : "max-w-5xl", className)}>{children}</main>;
}

export type Period = "day" | "week" | "month";

export function periodRange(period: Period, anchor: number): { from: number; to: number } {
  const day = startOfDay(anchor);
  if (period === "day") return { from: day, to: addDays(day, 1) };
  if (period === "week") return { from: addDays(day, -6), to: addDays(day, 1) };
  return { from: addDays(day, -29), to: addDays(day, 1) };
}

const addMonths = (day: number, n: number) => {
  const d = new Date(day * 1000);
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate()).getTime() / 1000;
};
const isoDate = (day: number) => {
  const d = new Date(day * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Date navigation. Like Gadgetbridge it can jump by a day, a week or a month; the date opens a calendar.
 * `compact` shows only the arrows of the current period (Home).
 */
export function DateNav({ day, onChange, period = "day", compact = false }: { day: number; onChange: (d: number) => void; period?: Period; compact?: boolean }) {
  const today = startOfDay(Date.now() / 1000);
  const { from } = periodRange(period, day);
  const label = period === "day" ? (day === today ? "Oggi" : day === addDays(today, -1) ? "Ieri" : fmtDayLong(day)) : `${fmtDay(from)} – ${fmtDay(day)}`;
  const go = (d: number) => onChange(Math.min(today, startOfDay(d)));
  const step = period === "day" ? 1 : period === "week" ? 7 : 30;
  const jumps: { label: string; title: string; to: (d: number) => number }[] = [
    { label: "M", title: "Un mese", to: (d) => addMonths(d, -1) },
    { label: "S", title: "Una settimana", to: (d) => addDays(d, -7) },
    { label: "G", title: "Un giorno", to: (d) => addDays(d, -1) },
  ];
  const picker = (
    <label className="hover:bg-accent relative flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium">
      <CalendarDaysIcon className="text-muted-foreground size-4 shrink-0" />
      <span className="truncate capitalize">{label}</span>
      <input
        type="date"
        aria-label="Scegli una data"
        max={isoDate(today)}
        value={isoDate(day)}
        onChange={(e) => {
          if (!e.target.value) return;
          const [y, m, dd] = e.target.value.split("-").map(Number);
          go(new Date(y, m - 1, dd).getTime() / 1000);
        }}
        onClick={(e) => {
          try {
            (e.currentTarget as HTMLInputElement).showPicker?.();
          } catch {
            /* not supported: the native input opens anyway */
          }
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </label>
  );
  if (compact)
    return (
      <div className="bg-card flex items-center justify-between rounded-xl border p-1">
        <Button variant="ghost" size="icon" onClick={() => go(addDays(day, -step))} aria-label="Precedente">
          <ChevronLeftIcon />
        </Button>
        {picker}
        <Button variant="ghost" size="icon" onClick={() => go(addDays(day, step))} disabled={day >= today} aria-label="Successivo">
          <ChevronRightIcon />
        </Button>
      </div>
    );
  return (
    <div className="bg-card flex items-center gap-0.5 rounded-xl border p-1">
      {jumps.map((j, i) => (
        <Button
          key={j.label}
          variant="ghost"
          size="sm"
          className={cn("text-muted-foreground px-2 tabular", i < 2 && "hidden sm:inline-flex")}
          onClick={() => go(j.to(day))}
          title={`Indietro di ${j.title.toLowerCase()}`}
          aria-label={`Indietro di ${j.title.toLowerCase()}`}
        >
          {i < 2 ? <ChevronsLeftIcon /> : <ChevronLeftIcon />}
          <span className="text-xs">{j.label}</span>
        </Button>
      ))}
      {picker}
      {[...jumps].reverse().map((j, i) => {
        const fwd = (d: number) => (j.label === "M" ? addMonths(d, 1) : addDays(d, j.label === "S" ? 7 : 1));
        return (
          <Button
            key={j.label}
            variant="ghost"
            size="sm"
            className={cn("text-muted-foreground px-2", i > 0 && "hidden sm:inline-flex")}
            onClick={() => go(fwd(day))}
            disabled={day >= today}
            title={`Avanti di ${j.title.toLowerCase()}`}
            aria-label={`Avanti di ${j.title.toLowerCase()}`}
          >
            <span className="text-xs">{j.label}</span>
            {i > 0 ? <ChevronsRightIcon /> : <ChevronRightIcon />}
          </Button>
        );
      })}
      {day < today && (
        <Button variant="outline" size="sm" className="ml-1 hidden md:inline-flex" onClick={() => onChange(today)}>
          Oggi
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
      <div className="bg-accent text-accent-foreground flex size-12 items-center justify-center rounded-full [&_svg]:size-6">{icon}</div>
      <div className="font-medium">{title}</div>
      {children && <div className="text-muted-foreground max-w-sm text-sm">{children}</div>}
      {action}
    </div>
  );
}

export function Stat({ label, value, unit, className }: { label: string; value: ReactNode; unit?: string; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-muted-foreground truncate text-xs">{label}</div>
      <div className="tabular truncate text-lg font-semibold">
        {value}
        {unit && <span className="text-muted-foreground ml-1 text-xs font-normal">{unit}</span>}
      </div>
    </div>
  );
}
