import { useEffect, useRef, useState } from "react";
import {
  BatteryFullIcon,
  BatteryLowIcon,
  BatteryMediumIcon,
  BellRingIcon,
  BluetoothIcon,
  BluetoothOffIcon,
  ChartColumnIcon,
  ClockIcon,
  EllipsisVerticalIcon,
  FileUpIcon,
  HeartPulseIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  Settings2Icon,
  Trash2Icon,
  TriangleAlertIcon,
  WatchIcon,
} from "lucide-react";
import { useApp, useLive } from "@/app-context";
import { EmptyState, PageBody, PageHeader } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { deleteDevice, updateDevice, type Device } from "@/lib/db/repo";
import type { LiveState } from "@/lib/device-manager";
import { fmtRelative } from "@/lib/format";
import { isWebBluetoothAvailable } from "@/lib/garmin/transport";
import { navigate, query, usePath } from "@/lib/router";
import { cn } from "@/lib/utils";
import { progressPct } from "./dashboard";

const STATE_LABEL: Record<string, string> = {
  idle: "Non connesso",
  connecting: "Connessione…",
  initializing: "Inizializzazione…",
  ready: "Connesso",
  syncing: "Sincronizzazione…",
  disconnected: "Non connesso",
};

export function DevicesPage() {
  const { devices } = useApp();
  const live = useLive();
  const path = usePath();
  const [pairOpen, setPairOpen] = useState(query(path).get("pair") === "1");
  useEffect(() => {
    if (query(path).get("pair") === "1") setPairOpen(true);
  }, [path]);

  return (
    <>
      <PageHeader
        title="Dispositivi"
        actions={
          <Button size="sm" onClick={() => setPairOpen(true)}>
            <PlusIcon /> Aggiungi
          </Button>
        }
      />
      <PageBody>
        {devices.length === 0 ? (
          <EmptyState
            icon={<WatchIcon />}
            title="Nessun dispositivo"
            action={
              <Button onClick={() => setPairOpen(true)}>
                <PlusIcon /> Aggiungi dispositivo
              </Button>
            }
          >
            Aggiungi il tuo Garmin vívosmart 5 per scaricare passi, sonno, battito, stress e Body Battery.
          </EmptyState>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {devices.map((d) => (
              <DeviceCard key={d.id} device={d} live={live.get(d.id)} />
            ))}
          </div>
        )}
      </PageBody>
      <PairDialog
        open={pairOpen}
        onOpenChange={(o) => {
          setPairOpen(o);
          if (!o && query(path).get("pair")) navigate("/devices", true);
        }}
      />
    </>
  );
}

function BatteryIcon({ level }: { level: number }) {
  const I = level > 60 ? BatteryFullIcon : level > 25 ? BatteryMediumIcon : BatteryLowIcon;
  return <I className={cn("size-4", level <= 15 && "text-destructive")} />;
}

function DeviceCard({ device, live }: { device: Device; live?: LiveState }) {
  const { manager, db, refreshDevices, bumpData } = useApp();
  const state = live?.state ?? "idle";
  const connected = state === "ready" || state === "syncing";
  const busy = state === "connecting" || state === "initializing";
  const battery = live?.battery ?? device.battery_level;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const progress = live?.progress;
  const showProgress = state === "syncing" || progress?.phase === "processing";

  const run = async (label: string, fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      if (okMsg) toast.success(okMsg);
    } catch (e) {
      toast.error(label, { description: (e as Error).message });
    }
  };

  return (
    <Card className="gap-4 py-4">
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3">
          <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-full", connected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
            <WatchIcon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">{device.alias || device.name}</span>
              {device.is_demo ? <Badge variant="secondary">Demo</Badge> : null}
            </div>
            <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
              {busy && <Loader2Icon className="size-3.5 animate-spin" />}
              <span className={cn(connected && "text-primary font-medium")}>{STATE_LABEL[state]}</span>
              <span>·</span>
              <span className="truncate">Sync {fmtRelative(device.last_sync)}</span>
            </div>
          </div>
          {battery != null && (
            <div className="flex items-center gap-1 text-sm font-medium tabular" title="Batteria">
              <BatteryIcon level={battery} />
              {battery}%
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="-mr-2" aria-label="Altre azioni">
                <EllipsisVerticalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem disabled={!connected} onSelect={() => void run("Impossibile impostare l'ora", () => manager.setTime(device.id), "Ora inviata al bracciale")}>
                <ClockIcon /> Imposta ora
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!connected} onSelect={() => void run("Errore", () => manager.refreshBattery(device.id))}>
                <BatteryMediumIcon /> Aggiorna batteria
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                <FileUpIcon /> Importa file .FIT
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void run("Rielaborazione fallita", () => manager.reprocessAll(device.id), "File rielaborati")}>
                <RotateCcwIcon /> Rielabora file scaricati
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate("/logs")}>
                <ScrollTextIcon /> Log e diagnostica
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                <Trash2Icon /> Elimina dispositivo
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {live?.error && (
          <Alert variant="destructive" className="py-2">
            <TriangleAlertIcon />
            <AlertDescription>{live.error}</AlertDescription>
          </Alert>
        )}

        {showProgress && (
          <div className="space-y-1.5">
            <div className="text-muted-foreground flex justify-between text-xs">
              <span>
                {progress?.phase === "directory" ? "Lettura elenco file…" : progress?.phase === "processing" ? "Elaborazione dati…" : `Download ${progress?.fileName ?? ""}`}
              </span>
              <span className="tabular">
                {progress?.filesDone ?? 0}/{progress?.filesTotal ?? 0}
              </span>
            </div>
            <Progress value={progressPct(progress)} />
          </div>
        )}

        {live?.liveHr != null && (
          <div className="bg-heart/10 text-heart flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium">
            <HeartPulseIcon className="size-4 animate-pulse" /> Battito in tempo reale: <span className="tabular text-base">{live.liveHr}</span> bpm
          </div>
        )}

        <div className="grid grid-cols-5 gap-1">
          <ActionButton
            icon={connected || busy ? <BluetoothOffIcon /> : <BluetoothIcon />}
            label={connected || busy ? "Disconnetti" : "Connetti"}
            onClick={() => void run("Connessione non riuscita", () => (connected || busy ? manager.disconnect(device.id) : manager.connect(device)))}
            primary={!connected && !busy}
          />
          <ActionButton icon={<RefreshCwIcon className={cn(state === "syncing" && "animate-spin")} />} label="Sincronizza" disabled={state !== "ready"} onClick={() => void run("Sincronizzazione non riuscita", () => manager.sync(device.id, true))} />
          <ActionButton icon={<ChartColumnIcon />} label="Grafici" onClick={() => navigate("/charts")} />
          <ActionButton
            icon={<BellRingIcon />}
            label="Trova"
            disabled={!connected}
            onClick={() => void run("Errore", () => manager.findDevice(device.id, true), "Il bracciale vibra per 60 secondi")}
          />
          <ActionButton icon={<Settings2Icon />} label="Opzioni" onClick={() => navigate(`/devices/${device.id}/settings`)} />
        </div>
        {connected && (
          <div className="flex items-center justify-between gap-4 border-t pt-3">
            <Label htmlFor={`hr-${device.id}`} className="block min-w-0 flex-1 text-sm font-normal">
              Dati in tempo reale
              <span className="text-muted-foreground block text-xs">Battito, passi, Body Battery e respirazione aggiornati sulla Home</span>
            </Label>
            <Switch
              id={`hr-${device.id}`}
              checked={live?.realtime != null}
              onCheckedChange={(v) =>
                void run("Errore", async () => {
                  await manager.setLive(device.id, v);
                  // remember the choice for the next connections
                  await updateDevice(db, device.id, { settings: { ...device.settings, liveOnConnect: v } });
                  await refreshDevices();
                })
              }
            />
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".fit,.FIT"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) void run("Importazione fallita", () => manager.importFiles(device.id, files), `${files.length} file importati`);
          }}
        />
      </CardContent>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eliminare {device.alias || device.name}?</DialogTitle>
            <DialogDescription>Puoi tenere i dati già scaricati oppure cancellare anche quelli. L'operazione non si può annullare.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Annulla
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                void run("Errore", async () => {
                  await manager.disconnect(device.id);
                  await deleteDevice(db, device.id, false);
                  await refreshDevices();
                  setConfirmDelete(false);
                }, "Dispositivo scollegato, dati mantenuti")
              }
            >
              Scollega e tieni i dati
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                void run("Errore", async () => {
                  await manager.disconnect(device.id);
                  await deleteDevice(db, device.id, true);
                  await refreshDevices();
                  bumpData();
                  setConfirmDelete(false);
                }, "Dispositivo e dati eliminati")
              }
            >
              Elimina tutto
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ActionButton({ icon, label, onClick, disabled, primary }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col items-center gap-1 rounded-lg py-2 text-[11px] font-medium transition-colors disabled:opacity-40 [&_svg]:size-5",
        primary ? "text-primary hover:bg-accent" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function PairDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { manager, refreshDevices, openDemo } = useApp();
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const supported = isWebBluetoothAvailable();

  const pair = async () => {
    setBusy(true);
    try {
      const promise = manager.pairNew(showAll);
      // the device row exists as soon as the chooser returns
      await promise;
      await refreshDevices();
      onOpenChange(false);
      toast.success("Bracciale collegato");
    } catch (e) {
      const msg = (e as Error).message;
      if (!/cancel|annull|User cancelled/i.test(msg)) toast.error("Abbinamento non riuscito", { description: msg });
      await refreshDevices();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Aggiungi dispositivo</DialogTitle>
          <DialogDescription>Supportati: Garmin vívosmart 5 e altri bracciali/orologi Garmin con protocollo GFDI.</DialogDescription>
        </DialogHeader>
        {!supported && (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Bluetooth non disponibile in questo browser</AlertTitle>
            <AlertDescription>Usa Chrome su Android, oppure Chrome o Edge su computer. Safari e Firefox non supportano Web Bluetooth.</AlertDescription>
          </Alert>
        )}
        <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm">
          <li>
            Se il bracciale è associato a <b className="text-foreground">Garmin Connect</b>, rimuovilo dall'app e dalle impostazioni Bluetooth del telefono: due app collegate insieme vanno in conflitto.
          </li>
          <li>Metti il vívosmart 5 in modalità abbinamento (di solito: menu › Impostazioni › Telefono › Associa telefono).</li>
          <li>
            Premi <b className="text-foreground">Cerca</b> e scegli <b className="text-foreground">vívosmart 5</b> dall'elenco del browser.
          </li>
          <li>Se il sistema mostra un codice di abbinamento, confermalo anche sul bracciale.</li>
        </ol>
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <Label htmlFor="show-all" className="text-sm font-normal">
            Mostra tutti i dispositivi Bluetooth
          </Label>
          <Switch id="show-all" checked={showAll} onCheckedChange={setShowAll} />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              onOpenChange(false);
              await openDemo();
            }}
          >
            Prova la demo
          </Button>
          <Button onClick={() => void pair()} disabled={!supported || busy}>
            {busy ? <Loader2Icon className="animate-spin" /> : <BluetoothIcon />} Cerca
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
