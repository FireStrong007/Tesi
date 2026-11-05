import { useMemo, useState, useSyncExternalStore } from "react";
import { CopyIcon, DownloadIcon, FileJsonIcon, Trash2Icon } from "lucide-react";
import { useApp, useLive } from "@/app-context";
import { PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { useQuery } from "@/hooks/use-query";
import { listFitFiles, tableCounts } from "@/lib/db/repo";
import { fmtBytes, fmtDateTime, fmtInt } from "@/lib/format";
import { logStore } from "@/lib/log";
import { cn } from "@/lib/utils";

function save(name: string, text: string, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Summary of the last sync and of what is in the database: the first thing to look at when charts stay empty. */
function Diagnostics() {
  const { db, devices, manager, dbInfo } = useApp();
  const live = useLive();
  const { data: counts } = useQuery(() => tableCounts(db), []);
  const { data: files } = useQuery(() => listFitFiles(db), []);
  const reports = manager.allReports();
  const errors = (files ?? []).filter((f) => f.error).length;
  const pending = (files ?? []).filter((f) => !f.processed_at).length;

  const downloadReport = () => {
    const report = {
      generatedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      database: dbInfo,
      devices: devices.map((d) => ({ id: d.id, name: d.name, model: d.model, firmware: d.firmware, product: d.product_number, demo: !!d.is_demo, lastSync: d.last_sync, settings: d.settings, live: live.get(d.id)?.state })),
      lastSyncs: reports,
      fitFiles: files,
      tableCounts: counts,
      log: logStore.asText(),
    };
    save(`vitabridge-diagnostica-${Date.now()}.json`, JSON.stringify(report, null, 2), "application/json");
  };

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Diagnostica</CardTitle>
        <CardDescription>Cosa ha elencato il bracciale all'ultima sincronizzazione e cosa è finito nel database.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {reports.length === 0 && <p className="text-muted-foreground">Nessuna sincronizzazione in questa sessione: connetti il bracciale e premi «Sincronizza».</p>}
        {reports.map((r) => {
          const dev = devices.find((d) => d.id === r.deviceId);
          return (
            <div key={r.deviceId} className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{dev?.alias || dev?.name}</span>
                <span className="text-muted-foreground">{fmtDateTime(r.startedAt)}</span>
                {r.finishedAt ? <Badge variant="secondary">completata</Badge> : <Badge variant="outline">in corso / interrotta</Badge>}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div><div className="text-muted-foreground text-xs">File elencati</div><div className="font-medium">{r.directory ? r.directory.length : "nessuna risposta"}</div></div>
                <div><div className="text-muted-foreground text-xs">Scaricati</div><div className="font-medium">{r.downloaded}</div></div>
                <div><div className="text-muted-foreground text-xs">Già presenti</div><div className="font-medium">{r.skipped}</div></div>
                <div><div className="text-muted-foreground text-xs">Errori</div><div className={cn("font-medium", r.failed && "text-destructive")}>{r.failed}</div></div>
              </div>
              {r.directory && r.directory.length > 0 && (
                <div className="max-h-48 overflow-y-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
                  {r.directory.map((e) => (
                    <div key={e.index} className={cn(!e.queued && "text-muted-foreground")}>
                      #{e.index} {e.type} · {fmtBytes(e.size)} · {e.date ? fmtDateTime(e.date) : "–"} {e.queued ? "→ scaricato" : "(ignorato)"}
                    </div>
                  ))}
                </div>
              )}
              {r.directory && r.directory.length === 0 && (
                <p className="text-muted-foreground">Il bracciale non ha file da dare: di solito succede subito dopo il primo abbinamento, finché non salva i primi dati.</p>
              )}
              {r.imported.length > 0 && (
                <div className="space-y-1 text-xs">
                  {r.imported.length > 8 && <div className="text-muted-foreground">Ultimi 8 di {r.imported.length} file importati:</div>}
                  {r.imported.slice(-8).map((i) => (
                    <div key={i.fileId} className={cn(i.error && "text-destructive")}>
                      {i.type ?? "FIT"} #{i.fileId}: {i.error ? `errore – ${i.error}` : Object.entries(i.counts).map(([k, v]) => `${k} ${v}`).join(", ") || "nessun dato riconosciuto"}
                      {i.warning ? ` (parziale: ${i.warning})` : ""}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div><div className="text-muted-foreground text-xs">File FIT salvati</div><div className="font-medium">{fmtInt(files?.length ?? 0)}</div></div>
          <div><div className="text-muted-foreground text-xs">Da importare / con errori</div><div className="font-medium">{pending} / {errors}</div></div>
          <div><div className="text-muted-foreground text-xs">Campioni attività</div><div className="font-medium">{fmtInt(counts?.activity_sample ?? 0)}</div></div>
          <div><div className="text-muted-foreground text-xs">Sonno / stress</div><div className="font-medium">{fmtInt(counts?.sleep_stage_sample ?? 0)} / {fmtInt(counts?.stress_sample ?? 0)}</div></div>
        </div>
        <Button variant="outline" onClick={downloadReport}>
          <FileJsonIcon /> Scarica report diagnostico
        </Button>
      </CardContent>
    </Card>
  );
}

export function LogsPage() {
  const entries = useSyncExternalStore(logStore.subscribe, logStore.get);
  const [debug, setDebug] = useState(false);
  const shown = useMemo(() => entries.filter((e) => debug || e.level !== "debug").slice(-500).reverse(), [entries, debug]);
  return (
    <>
      <PageHeader
        title="Log"
        subtitle="Utile per capire cosa succede con il Bluetooth"
        actions={
          <>
            <Button variant="ghost" size="icon" aria-label="Copia" onClick={async () => (await navigator.clipboard.writeText(logStore.asText()), toast.success("Log copiato"))}>
              <CopyIcon />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Scarica" onClick={() => save(`vitabridge-log-${Date.now()}.txt`, logStore.asText())}>
              <DownloadIcon />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Svuota" onClick={() => logStore.clear()}>
              <Trash2Icon />
            </Button>
          </>
        }
      />
      <PageBody>
        <Diagnostics />
        <div className="flex items-center gap-2">
          <Switch id="dbg" checked={debug} onCheckedChange={setDebug} />
          <Label htmlFor="dbg" className="font-normal">
            Mostra pacchetti (debug)
          </Label>
        </div>
        <Card className="gap-0 overflow-hidden py-0 font-mono text-xs">
          {shown.length === 0 && <div className="text-muted-foreground p-4">Ancora nessun messaggio. Connetti un dispositivo.</div>}
          {shown.map((e, i) => (
            <div key={entries.length - i} className={cn("flex gap-2 border-b px-3 py-1.5 last:border-0", e.level === "error" && "bg-destructive/10", e.level === "warn" && "bg-stress/10")}>
              <span className="text-muted-foreground shrink-0">{new Date(e.ts).toLocaleTimeString("it-IT")}</span>
              <span className="text-primary shrink-0">{e.source}</span>
              <span className={cn("min-w-0 break-all", e.level === "debug" && "text-muted-foreground")}>{e.msg}</span>
            </div>
          ))}
        </Card>
      </PageBody>
    </>
  );
}
