import type { ReactNode } from "react";
import { ArrowLeftIcon, CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { addDays, startOfDay } from "@bridge/core/db/queries";
import { fmtDayLong, fmtMonth, fmtWeekTitle } from "@bridge/core/format";
import { cn } from "@/lib/utils";
import { dayKey, fromDayKey, monthStart, weekStart } from "@bridge/core/time-zone";

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

/** The days shown for a period: the day, its Monday–Sunday week, or its calendar month (1st to last day). */
export function periodRange(period: Period, anchor: number): { from: number; to: number } {
  const day = startOfDay(anchor);
  if (period === "day") return { from: day, to: addDays(day, 1) };
  if (period === "week") {
    const monday = weekStart(day);
    return { from: monday, to: addDays(monday, 7) };
  }
  return { from: monthStart(day, 0), to: monthStart(day, 1) };
}

// days, weeks and months of the study's time zone (Europe/Rome), whatever the device's zone
export { monthStart };
const isoDate = dayKey;

/**
 * Date navigation: two arrows that move by the period (a day, a Monday–Sunday week, a calendar
 * month) and its label. Only the day opens a calendar. `compact` (Home) has no button back to today.
 */
export function DateNav({ day, onChange, period = "day", compact = false }: { day: number; onChange: (d: number) => void; period?: Period; compact?: boolean }) {
  const today = startOfDay(Date.now() / 1000);
  const { from, to } = periodRange(period, day);
  const current = today >= from && today < to;
  const go = (d: number) => onChange(Math.min(today, startOfDay(d)));
  // the next week and month start where this one ends
  const prev = period === "day" ? addDays(day, -1) : period === "week" ? addDays(from, -7) : monthStart(day, -1);
  const next = period === "day" ? addDays(day, 1) : to;
  const names = {
    day: ["Giorno precedente", "Giorno successivo", "Oggi"],
    week: ["Settimana precedente", "Settimana successiva", "Questa settimana"],
    month: ["Mese precedente", "Mese successivo", "Questo mese"],
  }[period];
  const center =
    period === "day" ? (
      <label className="hover:bg-accent relative flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium">
        <CalendarDaysIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate">{day === today ? "Oggi" : day === addDays(today, -1) ? "Ieri" : fmtDayLong(day)}</span>
        <input
          type="date"
          aria-label="Scegli una data"
          max={isoDate(today)}
          value={isoDate(day)}
          onChange={(e) => {
            if (!e.target.value) return;
            go(fromDayKey(e.target.value));
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
    ) : (
      <div className="flex min-w-0 flex-1 items-center justify-center px-2 py-1.5 text-sm font-medium">
        <span className="truncate">{period === "month" ? fmtMonth(day) : fmtWeekTitle(from, addDays(to, -1))}</span>
      </div>
    );
  return (
    <div className="bg-card flex items-center gap-0.5 rounded-xl border p-1">
      <Button variant="ghost" size="icon" onClick={() => go(prev)} aria-label={names[0]} title={names[0]}>
        <ChevronLeftIcon />
      </Button>
      {center}
      <Button variant="ghost" size="icon" onClick={() => go(next)} disabled={current} aria-label={names[1]} title={names[1]}>
        <ChevronRightIcon />
      </Button>
      {!compact && !current && (
        <Button variant="outline" size="sm" className="ml-1 hidden md:inline-flex" onClick={() => onChange(today)}>
          {names[2]}
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
