import { useEffect, useRef, useState } from "react";
import { Loader2Icon, PhoneIcon, TriangleAlertIcon } from "lucide-react";
import { AppProvider, useApp } from "@/app-context";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Toaster, toast } from "@/components/ui/sonner";
import { match, usePath } from "@/lib/router";
import { ChartsPage } from "@/pages/charts";
import { DashboardPage } from "@/pages/dashboard";
import { DeviceSettingsPage } from "@/pages/device-settings";
import { DevicesPage } from "@/pages/devices";
import { LogsPage } from "@/pages/logs";
import { SettingsPage } from "@/pages/settings";
import { WorkoutDetailPage, WorkoutsPage } from "@/pages/workouts";

function Routes() {
  const path = usePath();
  let p: Record<string, string> | null;
  if ((p = match("/devices/:id/settings", path))) return <DeviceSettingsPage id={Number(p.id)} />;
  if (match("/devices", path)) return <DevicesPage />;
  if (match("/charts", path)) return <ChartsPage />;
  if ((p = match("/workouts/:id", path))) return <WorkoutDetailPage id={Number(p.id)} />;
  if (match("/workouts", path)) return <WorkoutsPage />;
  if (match("/settings", path)) return <SettingsPage />;
  if (match("/logs", path)) return <LogsPage />;
  return <DashboardPage />;
}

/** "Find my phone" requested from the band: beep + vibrate until stopped (like Gadgetbridge). */
function FindPhone() {
  const { manager } = useApp();
  const [open, setOpen] = useState(false);
  const audio = useRef<{ ctx: AudioContext; timer: ReturnType<typeof setInterval> } | null>(null);
  const stop = () => {
    setOpen(false);
    if (audio.current) {
      clearInterval(audio.current.timer);
      void audio.current.ctx.close();
      audio.current = null;
    }
    navigator.vibrate?.(0);
  };
  useEffect(() => {
    manager.onFindPhone = (start) => {
      if (!start) return stop();
      setOpen(true);
      try {
        const ctx = new AudioContext();
        const beep = () => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.frequency.value = 880;
          g.gain.value = 0.2;
          o.connect(g).connect(ctx.destination);
          o.start();
          o.stop(ctx.currentTime + 0.35);
          navigator.vibrate?.([300, 200, 300]);
        };
        beep();
        audio.current = { ctx, timer: setInterval(beep, 1200) };
      } catch {
        /* audio not allowed without a user gesture */
      }
    };
    return () => {
      manager.onFindPhone = null;
    };
  }, [manager]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && stop()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PhoneIcon className="size-5" /> Il bracciale sta cercando il telefono
          </DialogTitle>
          <DialogDescription>Hai trovato il telefono? Ferma il segnale.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={stop}>Trovato</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Explains the outcome of a manual sync. */
function SyncResults() {
  const { manager } = useApp();
  useEffect(() => {
    manager.onManualSyncDone = (_id, r) => {
      if (r.failed) toast.error(`Sincronizzazione: ${r.downloaded} file scaricati, ${r.failed} con errori`, { description: "Dettagli nella pagina Log." });
      else if (r.downloaded > 0) toast.success(`Sincronizzazione completata: ${r.downloaded} ${r.downloaded === 1 ? "file nuovo" : "file nuovi"}`);
      else
        toast("Nessun file nuovo sul bracciale", {
          description:
            r.listed === 0
              ? "Il bracciale non ha elencato file: di solito succede poco dopo l'abbinamento, finché non salva i primi dati. Intanto la Home usa i dati in tempo reale."
              : "I file già scaricati sono stati archiviati; quelli nuovi compaiono quando il bracciale li salva. Intanto la Home usa i dati in tempo reale.",
        });
    };
    return () => {
      manager.onManualSyncDone = null;
    };
  }, [manager]);
  return null;
}

function Splash({ error }: { error: Error | null }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <img src="icon.svg" alt="" className="size-14" />
      {error ? (
        <>
          <TriangleAlertIcon className="text-destructive size-6" />
          <div className="font-semibold">Impossibile aprire il database</div>
          <div className="text-muted-foreground max-w-sm text-sm">{error.message}</div>
        </>
      ) : (
        <Loader2Icon className="text-muted-foreground size-6 animate-spin" />
      )}
    </div>
  );
}

export default function App() {
  return (
    <AppProvider fallback={(e) => <Splash error={e} />}>
      <AppShell>
        <Routes />
      </AppShell>
      <FindPhone />
      <SyncResults />
      <Toaster />
    </AppProvider>
  );
}
