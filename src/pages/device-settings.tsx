import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "@/app-context";
import { PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { useQuery } from "@/hooks/use-query";
import { getDevice, listFitFiles, updateDevice, type DeviceSettings } from "@/lib/db/repo";
import { DEFAULT_SETTINGS } from "@/lib/device-manager";
import { fmtBytes, fmtDateTime } from "@/lib/format";
import { navigate } from "@/lib/router";

function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {desc && <div className="text-muted-foreground text-xs">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

export function DeviceSettingsPage({ id }: { id: number }) {
  const { db, refreshDevices, manager } = useApp();
  const { data: device } = useQuery(() => getDevice(db, id), [id]);
  const { data: files } = useQuery(() => listFitFiles(db, id), [id]);
  const [s, setS] = useState<Required<DeviceSettings>>(DEFAULT_SETTINGS);
  const [alias, setAlias] = useState("");

  useEffect(() => {
    if (device) {
      setS({ ...DEFAULT_SETTINGS, ...device.settings });
      setAlias(device.alias ?? "");
    }
  }, [device]);

  if (!device) return <PageHeader title="Opzioni dispositivo" back={() => navigate("/devices")} />;

  const save = async (next: Partial<DeviceSettings>) => {
    const merged = { ...s, ...next };
    setS(merged);
    await updateDevice(db, id, { settings: merged });
    await refreshDevices();
    await manager.applySettings(id, merged).catch(() => {});
    if (manager.isConnected(id)) toast("Salvato", { description: "Alcune opzioni valgono dalla prossima connessione." });
  };

  return (
    <>
      <PageHeader title={device.alias || device.name} subtitle="Opzioni dispositivo" back={() => navigate("/devices")} />
      <PageBody>
        <Card className="gap-2">
          <CardHeader>
            <CardTitle>Informazioni</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Info k="Modello" v={device.model} />
            <Info k="Firmware" v={device.firmware} />
            <Info k="Numero unità" v={device.unit_number} />
            <Info k="Prodotto" v={device.product_number?.toString()} />
            <Info k="ID Bluetooth" v={device.ble_id} />
            <Info k="Aggiunto il" v={fmtDateTime(device.created_at)} />
          </CardContent>
        </Card>

        <Card className="gap-2">
          <CardHeader>
            <CardTitle>Generale</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <div className="flex items-end gap-2 pb-3">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="alias">Nome personalizzato</Label>
                <Input id="alias" value={alias} placeholder={device.name} onChange={(e) => setAlias(e.target.value)} />
              </div>
              <Button
                variant="outline"
                onClick={async () => {
                  await updateDevice(db, id, { alias: alias.trim() || null });
                  await refreshDevices();
                  toast.success("Nome salvato");
                }}
              >
                Salva
              </Button>
            </div>
            <Row title="Sincronizza alla connessione" desc="Scarica subito i nuovi dati quando il bracciale si collega">
              <Switch checked={s.autoSyncOnConnect} onCheckedChange={(v) => void save({ autoSyncOnConnect: v })} />
            </Row>
            <Row title="Dati in tempo reale" desc="Apre i canali live del bracciale appena si collega: la Home si aggiorna da sola. Consuma un po' più batteria">
              <Switch checked={s.liveOnConnect} onCheckedChange={(v) => void save({ liveOnConnect: v })} />
            </Row>
            <Row title="SpO₂ in tempo reale" desc="Tiene acceso il sensore di ossigeno: consuma molta batteria">
              <Switch checked={s.liveSpo2} disabled={!s.liveOnConnect} onCheckedChange={(v) => void save({ liveSpo2: v })} />
            </Row>
            <Row title="Sincronizzazione automatica" desc="Scarica i nuovi dati a intervalli mentre il bracciale è connesso e l'app è aperta">
              <Select value={String(s.autoSyncMinutes)} onValueChange={(v) => void save({ autoSyncMinutes: Number(v) })}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Disattivata</SelectItem>
                  <SelectItem value="5">Ogni 5 min</SelectItem>
                  <SelectItem value="15">Ogni 15 min</SelectItem>
                  <SelectItem value="30">Ogni 30 min</SelectItem>
                  <SelectItem value="60">Ogni ora</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row title="Imposta l'ora alla connessione" desc="Invia data, ora e fuso orario del telefono">
              <Switch checked={s.syncTimeOnConnect} onCheckedChange={(v) => void save({ syncTimeOnConnect: v })} />
            </Row>
            <Row title="Mantieni i dati sul bracciale" desc="Non marcare i file come archiviati dopo il download (come in Gadgetbridge)">
              <Switch checked={s.keepOnDevice} onCheckedChange={(v) => void save({ keepOnDevice: v })} />
            </Row>
          </CardContent>
        </Card>

        <Card className="gap-2">
          <CardHeader>
            <CardTitle>Avanzate</CardTitle>
            <CardDescription>Da modificare solo se la connessione non funziona: le differenze sono spiegate nel README.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <Row title="Funzioni annunciate al bracciale" desc="«Come Gadgetbridge» usa lo stesso elenco di capacità dell'app Android">
              <Select value={s.capabilityProfile} onValueChange={(v) => void save({ capabilityProfile: v as DeviceSettings["capabilityProfile"] })}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gadgetbridge">Come Gadgetbridge</SelectItem>
                  <SelectItem value="minimal">Minime</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row title="Dimensione scrittura BLE" desc="Byte per pacchetto inviato (20 è il valore più sicuro)">
              <Select value={String(s.maxWriteSize)} onValueChange={(v) => void save({ maxWriteSize: Number(v) })}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[20, 100, 182, 244, 512].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row title="Scarica anche file sconosciuti" desc="Salva nel database anche i tipi FIT che l'app non importa">
              <Switch checked={s.fetchUnknownFiles} onCheckedChange={(v) => void save({ fetchUnknownFiles: v })} />
            </Row>
          </CardContent>
        </Card>

        <Card className="gap-2">
          <CardHeader>
            <CardTitle>File scaricati</CardTitle>
            <CardDescription>{files?.length ?? 0} file FIT conservati nel database</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-80 overflow-y-auto">
              {(files ?? []).slice(0, 200).map((f, i) => (
                <div key={f.id}>
                  {i > 0 && <Separator />}
                  <div className="flex items-center justify-between gap-2 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{f.file_type ?? "FIT"}</div>
                      <div className="text-muted-foreground text-xs">{f.file_date ? fmtDateTime(f.file_date) : "–"} · {fmtBytes(f.file_size)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {f.error ? <span className="text-destructive text-xs">Errore</span> : f.processed_at ? <span className="text-muted-foreground text-xs">Importato</span> : <span className="text-xs">In attesa</span>}
                      <Button variant="ghost" size="sm" onClick={() => void downloadFit(db, f.id, f.file_type)}>
                        Scarica
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}

function Info({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground text-xs">{k}</div>
      <div className="truncate font-medium">{v || "–"}</div>
    </div>
  );
}

async function downloadFit(db: ReturnType<typeof useApp>["db"], id: number, type: string | null) {
  const row = (await db.all<{ data: Uint8Array; file_date: number | null }>("SELECT data, file_date FROM fit_file WHERE id = ?", [id]))[0];
  if (!row) return;
  const blob = new Blob([new Uint8Array(row.data)], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${type ?? "file"}_${row.file_date ?? id}.fit`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
