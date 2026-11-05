import type { ReactNode } from "react";
import { ChartColumnIcon, HouseIcon, ScrollTextIcon, SettingsIcon, TimerIcon, WatchIcon } from "lucide-react";
import { useApp } from "@/app-context";
import { navigate, usePath } from "@/lib/router";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Home", icon: HouseIcon },
  { to: "/devices", label: "Dispositivi", icon: WatchIcon },
  { to: "/charts", label: "Grafici", icon: ChartColumnIcon },
  { to: "/workouts", label: "Attività", icon: TimerIcon },
  { to: "/settings", label: "Impostazioni", icon: SettingsIcon },
];

const isActive = (path: string, to: string) => (to === "/" ? path === "/" : path === to || path.startsWith(to + "/") || path.startsWith(to + "?"));

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePath();
  const { devices, live, dbInfo } = useApp();
  const connected = devices.filter((d) => {
    const s = live.get(d.id)?.state;
    return s && s !== "idle" && s !== "disconnected";
  });
  return (
    <div className="min-h-dvh md:flex">
      <aside className="bg-card sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r md:flex">
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-6">
          <img src="icon.svg" alt="" className="size-8" />
          <div>
            <div className="font-semibold leading-tight">VitaBridge</div>
            <div className="text-muted-foreground text-xs">I tuoi dati, sul tuo dispositivo</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {NAV.map((n) => (
            <a
              key={n.to}
              href={`#${n.to}`}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive(path, n.to) ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <n.icon className="size-4" />
              {n.label}
            </a>
          ))}
          <a
            href="#/logs"
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive(path, "/logs") ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <ScrollTextIcon className="size-4" />
            Log
          </a>
        </nav>
        <div className="text-muted-foreground space-y-1 border-t px-5 py-4 text-xs">
          <div className="flex items-center gap-2">
            <span className={cn("size-2 rounded-full", connected.length ? "bg-steps" : "bg-muted-foreground/40")} />
            {connected.length ? `${connected.length} dispositivo connesso` : "Nessun dispositivo connesso"}
          </div>
          <div>{dbInfo.persistent ? "Database SQLite locale (OPFS)" : "Database temporaneo (in memoria)"}</div>
        </div>
      </aside>
      <div className="min-w-0 flex-1 pb-20 md:pb-0">{children}</div>
      <nav className="bg-card/95 pb-safe fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur md:hidden">
        <div className="grid grid-cols-5">
          {NAV.map((n) => {
            const active = isActive(path, n.to);
            return (
              <button key={n.to} onClick={() => navigate(n.to)} className="flex flex-col items-center gap-1 py-2 text-[11px] font-medium">
                <span className={cn("flex h-7 w-14 items-center justify-center rounded-full transition-colors", active ? "bg-accent text-accent-foreground" : "text-muted-foreground")}>
                  <n.icon className="size-5" />
                </span>
                <span className={active ? "text-foreground" : "text-muted-foreground"}>{n.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
