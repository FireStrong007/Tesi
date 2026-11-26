import type { ReactNode } from "react";
import { ChartColumnIcon, CloudOffIcon, HouseIcon, LogOutIcon, SettingsIcon, WatchIcon } from "lucide-react";
import { useApp } from "@/app-context";
import { useAuth, useMe } from "@/auth";
import { fmtRelative } from "@bridge/core/format";
import { navigate, usePath } from "@/lib/router";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Home", icon: HouseIcon },
  { to: "/charts", label: "Grafici", icon: ChartColumnIcon },
  { to: "/devices", label: "Dispositivi", icon: WatchIcon },
  { to: "/settings", label: "Impostazioni", icon: SettingsIcon },
];

/** the menu entry of a path: "/" only for the Home itself, the others also for their sub-pages */
export const isActive = (path: string, to: string) => {
  const p = path.split("?")[0];
  return to === "/" ? p === "/" || p === "" : p === to || p.startsWith(to + "/");
};

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePath();
  const me = useMe();
  const { logout } = useAuth();
  const { status } = useApp();
  return (
    <div className="min-h-dvh md:flex">
      <aside className="bg-card sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r md:flex">
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-6">
          <img src="icon.svg" alt="" className="size-8" />
          <div>
            <div className="leading-tight font-semibold">{me.app.label}</div>
            <div className="text-muted-foreground text-xs">I tuoi dati dello studio</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3" aria-label="Sezioni">
          {NAV.map((n) => {
            const active = isActive(path, n.to);
            return (
              <a
                key={n.to}
                href={`#${n.to}`}
                aria-current={active ? "page" : undefined}
                // the current page must not look like the entry under the mouse: bold, with a bar on the left
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  active ? "bg-accent text-accent-foreground font-semibold shadow-[inset_3px_0_0_var(--primary)]" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground font-medium",
                )}
              >
                <n.icon className="size-4" />
                {n.label}
              </a>
            );
          })}
        </nav>
        <div className="text-muted-foreground space-y-1 border-t px-5 py-4 text-xs">
          <div className="flex items-center gap-2">
            {status.error ? <CloudOffIcon className="size-3.5" /> : <span className={cn("size-2 rounded-full", status.syncing ? "bg-steps animate-pulse" : "bg-steps")} />}
            {status.syncing ? "Sincronizzazione…" : `Aggiornato ${fmtRelative(status.lastSyncAt ? status.lastSyncAt / 1000 : null)}`}
          </div>
          <button onClick={() => void logout()} className="hover:text-foreground mt-2 flex items-center gap-2 font-medium">
            <LogOutIcon className="size-3.5" /> Esci ({me.account.username})
          </button>
        </div>
      </aside>
      {/* the space under the content is the bottom menu's height (index.css --bottom-nav): nothing ends under it */}
      <div className="min-w-0 flex-1 pb-[var(--bottom-nav)]">
        {status.error && (
          <div className="bg-muted text-muted-foreground flex items-center gap-2 border-b px-4 py-2 text-sm md:px-8" role="status">
            <CloudOffIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{status.error}</span>
          </div>
        )}
        {children}
      </div>
      <nav className="bg-card/95 pb-safe fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur md:hidden" aria-label="Sezioni">
        {/* a fixed height: --bottom-nav in index.css is this plus the border and the safe area */}
        <div className="grid h-16 grid-cols-4">
          {NAV.map((n) => {
            const active = isActive(path, n.to);
            return (
              <button key={n.to} onClick={() => navigate(n.to)} aria-current={active ? "page" : undefined} className="flex min-w-0 flex-col items-center justify-center gap-1 text-[11px] font-medium">
                <span className={cn("flex h-7 w-12 items-center justify-center rounded-full transition-colors", active ? "bg-accent text-accent-foreground" : "text-muted-foreground")}>
                  <n.icon className="size-5" />
                </span>
                <span className={cn("max-w-full truncate px-0.5", active ? "text-foreground" : "text-muted-foreground")}>{n.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
