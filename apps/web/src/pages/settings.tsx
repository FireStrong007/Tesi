import { useEffect, useState } from "react";
import { DatabaseIcon, Loader2Icon, RefreshCwIcon, TargetIcon } from "lucide-react";
import { useApp } from "@/app-context";
import { AccountCard } from "@/components/account-card";
import { PageBody, PageHeader } from "@/components/page";
import { useTheme, type Theme } from "@/components/theme";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useQuery } from "@/hooks/use-query";
import { errorMessage } from "@/lib/api";
import { GOAL_LIMITS, type Goals } from "@bridge/core/goals";
import { fmtBytes, fmtDateTime } from "@bridge/core/format";

const GOAL_KEYS = Object.keys(GOAL_LIMITS) as (keyof Goals)[];

function GoalsCard() {
  const { user, saveGoals } = useApp();
  const [form, setForm] = useState<Record<keyof Goals, string>>(() => Object.fromEntries(GOAL_KEYS.map((k) => [k, String(user[k])])) as Record<keyof Goals, string>);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(Object.fromEntries(GOAL_KEYS.map((k) => [k, String(user[k])])) as Record<keyof Goals, string>), [user]);
  const changed = GOAL_KEYS.some((k) => form[k] !== String(user[k]));
  const save = async () => {
    setBusy(true);
    try {
      await saveGoals(Object.fromEntries(GOAL_KEYS.map((k) => [k, Number(form[k])])) as Partial<Goals>);
      toast.success("Obiettivi salvati");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TargetIcon className="size-4" /> Obiettivi
        </CardTitle>
        <CardDescription>Le linee degli obiettivi nei grafici. Restano salvati con il tuo account, anche dopo l'uscita.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {GOAL_KEYS.map((k) => (
            <div key={k} className="space-y-1.5">
              <Label htmlFor={`goal-${k}`}>{GOAL_LIMITS[k].label}</Label>
              <Input
                id={`goal-${k}`}
                type="number"
                inputMode="numeric"
                min={GOAL_LIMITS[k].min}
                max={GOAL_LIMITS[k].max}
                value={form[k]}
                onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <Button onClick={() => void save()} disabled={!changed || busy}>
          {busy && <Loader2Icon className="animate-spin" />} Salva obiettivi
        </Button>
      </CardContent>
    </Card>
  );
}

function LocalDataCard() {
  const { db, persistent, status, redownload, dataVersion } = useApp();
  const [confirm, setConfirm] = useState(false);
  const { data: size } = useQuery(async () => {
    const [r] = await db.all<{ n: number }>("SELECT page_count * page_size AS n FROM pragma_page_count, pragma_page_size");
    return r?.n ?? 0;
  }, [dataVersion]);
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseIcon className="size-4" /> Dati su questo dispositivo
        </CardTitle>
        <CardDescription>
          {persistent
            ? "Una copia dei tuoi dati è salvata in questo browser per aprirli subito e anche senza connessione. Quando esci viene cancellata."
            : "Questo browser non permette di salvare i dati: vengono scaricati di nuovo a ogni apertura."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-muted-foreground text-xs">Spazio occupato</div>
            <div className="tabular font-medium">{size != null ? fmtBytes(size) : "–"}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Ultimo aggiornamento</div>
            <div className="font-medium">{status.lastSyncAt ? fmtDateTime(status.lastSyncAt / 1000) : "mai"}</div>
          </div>
        </div>
        <Button variant="outline" onClick={() => setConfirm(true)} disabled={status.syncing}>
          <RefreshCwIcon /> Riscarica tutto
        </Button>
      </CardContent>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Riscaricare tutti i dati?</DialogTitle>
            <DialogDescription>La copia su questo dispositivo viene svuotata e scaricata di nuovo dal server. Serve solo se qualcosa non torna.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Annulla
            </Button>
            <Button
              onClick={() => {
                setConfirm(false);
                void redownload();
              }}
            >
              Riscarica
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function SettingsPage() {
  const [theme, setTheme] = useTheme();
  return (
    <>
      <PageHeader title="Impostazioni" />
      <PageBody>
        <AccountCard />
        <GoalsCard />
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>Aspetto</CardTitle>
          </CardHeader>
          <CardContent>
            <ToggleGroup type="single" value={theme} onValueChange={(v) => v && setTheme(v as Theme)}>
              <ToggleGroupItem value="light">Chiaro</ToggleGroupItem>
              <ToggleGroupItem value="dark">Scuro</ToggleGroupItem>
              <ToggleGroupItem value="system">Sistema</ToggleGroupItem>
            </ToggleGroup>
          </CardContent>
        </Card>
        <LocalDataCard />
      </PageBody>
    </>
  );
}
