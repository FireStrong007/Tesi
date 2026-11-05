import { useEffect, useRef, useState } from "react";
import { DatabaseIcon, DownloadIcon, ScrollTextIcon, ShieldCheckIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { navigate } from "@/lib/router";
import { useApp } from "@/app-context";
import { PageBody, PageHeader } from "@/components/page";
import { GadgetbridgeImportCard } from "@/components/gadgetbridge-import";
import { useTheme, type Theme } from "@/components/theme";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useQuery } from "@/hooks/use-query";
import { tableCounts, updateUser, type User } from "@/lib/db/repo";
import { fmtBytes, fmtInt } from "@/lib/format";

const FIELDS: { key: keyof User; label: string; type: "text" | "number" | "date"; unit?: string }[] = [
  { key: "name", label: "Nome", type: "text" },
  { key: "birthday", label: "Data di nascita", type: "date" },
  { key: "height_cm", label: "Altezza", type: "number", unit: "cm" },
  { key: "weight_kg", label: "Peso", type: "number", unit: "kg" },
  { key: "step_goal", label: "Obiettivo passi", type: "number", unit: "passi" },
  { key: "sleep_goal_min", label: "Obiettivo sonno", type: "number", unit: "min" },
  { key: "active_minutes_goal", label: "Minuti di intensità settimanali", type: "number", unit: "min" },
  { key: "distance_goal_m", label: "Obiettivo distanza", type: "number", unit: "m" },
];

export function SettingsPage() {
  const { db, user, refreshUser, dbInfo, manager, refreshDevices, bumpData } = useApp();
  const [theme, setTheme] = useTheme();
  const [form, setForm] = useState<Partial<User>>(user);
  const [wipeOpen, setWipeOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { data: counts } = useQuery(() => tableCounts(db), []);
  const [storage, setStorage] = useState<{ usage?: number; quota?: number; persisted?: boolean }>({});
  useEffect(() => {
    void (async () => {
      const est = await navigator.storage?.estimate?.();
      const persisted = await navigator.storage?.persisted?.();
      setStorage({ usage: est?.usage, quota: est?.quota, persisted });
    })();
  }, [counts]);
  useEffect(() => setForm(user), [user]);

  const saveProfile = async () => {
    const patch: Partial<User> = {};
    for (const f of FIELDS) {
      const v = form[f.key];
      (patch as Record<string, unknown>)[f.key] = f.type === "number" ? (v === "" || v == null ? null : Number(v)) : v || null;
    }
    if (!patch.name) patch.name = "Io";
    await updateUser(db, user.id, patch);
    await refreshUser();
    bumpData();
    toast.success("Profilo salvato");
  };

  const exportDb = async () => {
    const bytes = await db.exportDb();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/vnd.sqlite3" }));
    a.download = `vitabridge-${new Date().toISOString().slice(0, 10)}.sqlite`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const importDb = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder().decode(bytes.subarray(0, 15)) !== "SQLite format 3") {
      toast.error("Il file non è un database SQLite");
      return;
    }
    await manager.disconnectAll();
    await db.importDb(bytes);
    await refreshUser();
    await refreshDevices();
    bumpData();
    toast.success("Database importato");
  };

  return (
    <>
      <PageHeader title="Impostazioni" />
      <PageBody>
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>Profilo</CardTitle>
            <CardDescription>Usato per obiettivi e statistiche. Non viene inviato da nessuna parte.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={f.key}>
                    {f.label} {f.unit && <span className="text-muted-foreground font-normal">({f.unit})</span>}
                  </Label>
                  <Input id={f.key} type={f.type} value={(form[f.key] as string | number | null) ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
                </div>
              ))}
              <div className="space-y-1.5">
                <Label>Sesso</Label>
                <Select value={form.gender ?? "none"} onValueChange={(v) => setForm({ ...form, gender: v === "none" ? null : v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Non specificato</SelectItem>
                    <SelectItem value="female">Femmina</SelectItem>
                    <SelectItem value="male">Maschio</SelectItem>
                    <SelectItem value="other">Altro</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button onClick={() => void saveProfile()}>Salva profilo</Button>
          </CardContent>
        </Card>

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

        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DatabaseIcon className="size-4" /> Dati
            </CardTitle>
            <CardDescription>
              SQLite {dbInfo.version} · {dbInfo.persistent ? "salvato nello spazio privato del browser (OPFS)" : "in memoria: i dati andranno persi alla chiusura"}
              {storage.usage != null && ` · ${fmtBytes(storage.usage)} usati`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <ShieldCheckIcon />
              <AlertTitle>I dati restano su questo dispositivo</AlertTitle>
              <AlertDescription>
                Nessun server: il database vive solo in questo browser. Esportalo regolarmente per avere una copia o per aprirlo su un altro dispositivo.
                {storage.persisted === false && " Il browser potrebbe liberare spazio in caso di memoria piena: installa l'app o concedi l'archiviazione persistente."}
              </AlertDescription>
            </Alert>
            {storage.persisted === false && (
              <Button variant="outline" onClick={async () => toast((await navigator.storage.persist()) ? "Archiviazione persistente attiva" : "Il browser non l'ha concessa")}>
                Richiedi archiviazione persistente
              </Button>
            )}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              {counts &&
                [
                  ["Campioni attività", counts.activity_sample],
                  ["Fasi del sonno", counts.sleep_stage_sample],
                  ["Stress", counts.stress_sample],
                  ["Body Battery", counts.body_energy_sample],
                  ["SpO₂", counts.spo2_sample],
                  ["HRV", counts.hrv_value_sample],
                  ["Attività sportive", counts.workout],
                  ["File FIT", counts.fit_file],
                ].map(([k, v]) => (
                  <div key={k as string}>
                    <div className="text-muted-foreground text-xs">{k}</div>
                    <div className="tabular font-medium">{fmtInt(v as number)}</div>
                  </div>
                ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void exportDb()}>
                <DownloadIcon /> Esporta database (.sqlite)
              </Button>
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                <UploadIcon /> Importa database
              </Button>
              <Button variant="outline" onClick={() => navigate("/logs")}>
                <ScrollTextIcon /> Log e diagnostica
              </Button>
              <Button variant="outline" className="text-destructive" onClick={() => setWipeOpen(true)}>
                <Trash2Icon /> Cancella tutti i dati
              </Button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".sqlite,.sqlite3,.db,application/vnd.sqlite3"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void importDb(f).catch((err) => toast.error("Importazione fallita", { description: (err as Error).message }));
              }}
            />
          </CardContent>
        </Card>

        <GadgetbridgeImportCard />

        <Card className="gap-2">
          <CardHeader>
            <CardTitle>Informazioni</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              VitaBridge è una web app indipendente ispirata a Gadgetbridge: parla direttamente con il bracciale tramite Web Bluetooth, senza account e senza cloud.
            </p>
            <p>
              Il protocollo Garmin (GFDI / Multi-Link) e il profilo FIT sono stati portati dal codice di Gadgetbridge, rilasciato sotto licenza AGPL-3.0: anche questa app è distribuita con la stessa licenza.
            </p>
            <p>Non è un dispositivo medico: i valori sono indicativi.</p>
          </CardContent>
        </Card>
      </PageBody>

      <Dialog open={wipeOpen} onOpenChange={setWipeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancellare tutti i dati?</DialogTitle>
            <DialogDescription>Profilo, dispositivi, campioni e file FIT verranno eliminati da questo browser. Se non hai un'esportazione non potrai recuperarli.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWipeOpen(false)}>
              Annulla
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                await manager.disconnectAll();
                await db.wipe();
                await refreshUser();
                await refreshDevices();
                bumpData();
                setWipeOpen(false);
                toast.success("Dati cancellati");
              }}
            >
              Cancella tutto
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
