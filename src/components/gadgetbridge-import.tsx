import { useRef, useState } from "react";
import { ArchiveIcon, CheckCircle2Icon, FileUpIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useApp } from "@/app-context";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { scanImport, type GbScan, type ImportReport } from "@/lib/gb-import";
import { fmtInt } from "@/lib/format";
import { navigate } from "@/lib/router";

type Step = "pick" | "scanning" | "confirm" | "running" | "done";

/** "Importa da Gadgetbridge": reads Gadgetbridge's export zip (or loose .fit files) into the local database. */
export function GadgetbridgeImportCard() {
  const { manager, devices, user, refreshDevices } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("pick");
  const [scan, setScan] = useState<GbScan | null>(null);
  const [target, setTarget] = useState<string>("new");
  const [progress, setProgress] = useState({ phase: "store" as "store" | "import", done: 0, total: 1 });
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const realDevices = devices.filter((d) => !d.is_demo);

  const reset = () => {
    setStep("pick");
    setScan(null);
    setReport(null);
    setError(null);
  };

  const onPick = async (files: File[]) => {
    if (!files.length) return;
    reset();
    setOpen(true);
    setStep("scanning");
    try {
      const s = await scanImport(files);
      setScan(s);
      setTarget(realDevices[0] ? String(realDevices[0].id) : "new");
      setStep("confirm");
    } catch (e) {
      setError((e as Error).message);
      setStep("pick");
    }
  };

  const run = async () => {
    if (!scan) return;
    setStep("running");
    try {
      const r = await manager.importExternal(
        scan.fitFiles,
        { userId: user.id, fallbackDevice: target === "new" ? "new" : Number(target), newDeviceName: "vívosmart 5" },
        (phase, done, total) => setProgress({ phase, done, total: Math.max(total, 1) }),
      );
      await refreshDevices();
      setReport(r);
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
      setStep("confirm");
    }
  };

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArchiveIcon className="size-4" /> Importa da Gadgetbridge
        </CardTitle>
        <CardDescription>
          Usi Gadgetbridge durante la giornata? Esporta i suoi dati come zip e caricali qui: passi, sonno, battito, stress, Body Battery, HRV e attività arrivano nei grafici.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-sm">
          <li>In Gadgetbridge apri le impostazioni, sezione gestione/backup dei dati, ed esporta lo zip.</li>
          <li>Scegli qui il file .zip (vanno bene anche singoli file .fit).</li>
        </ol>
        <p className="text-muted-foreground text-xs">
          I file già presenti vengono riconosciuti e saltati: puoi importare lo stesso zip più volte, anche alternandolo alla sincronizzazione diretta del bracciale.
        </p>
        <Button onClick={() => input.current?.click()}>
          <FileUpIcon /> Scegli zip o file .fit
        </Button>
        <input
          ref={input}
          type="file"
          accept=".zip,application/zip,.fit,.FIT"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            void onPick(files);
          }}
        />
      </CardContent>

      <Dialog open={open} onOpenChange={(o) => step !== "running" && setOpen(o)}>
        <DialogContent showCloseButton={step !== "running"}>
          <DialogHeader>
            <DialogTitle>Importa da Gadgetbridge</DialogTitle>
            <DialogDescription>
              {step === "scanning" && "Lettura del file…"}
              {step === "confirm" && scan && (scan.kind === "gadgetbridge-zip" ? "Esportazione di Gadgetbridge riconosciuta." : "File pronti per l'importazione.")}
              {step === "running" && "Importazione in corso: non chiudere la pagina."}
              {step === "done" && "Importazione completata."}
            </DialogDescription>
          </DialogHeader>

          {error && (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {step === "scanning" && <Loader2Icon className="text-muted-foreground mx-auto size-6 animate-spin" />}

          {step === "confirm" && scan && (
            <div className="space-y-4">
              {scan.fitFiles.length === 0 ? (
                <Alert>
                  <TriangleAlertIcon />
                  <AlertDescription>
                    Non ho trovato file .fit. {scan.hasGadgetbridgeDatabase ? "Lo zip contiene il database di Gadgetbridge ma non la cartella dei file: verifica che l'esportazione includa i file." : "Controlla di aver scelto lo zip esportato da Gadgetbridge."}
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-muted-foreground text-xs">File FIT trovati</div>
                    <div className="text-lg font-semibold">{fmtInt(scan.fitFiles.length)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs">Bracciali nello zip</div>
                    <div className="text-lg font-semibold">{scan.bands.length || "–"}</div>
                  </div>
                </div>
              )}
              {scan.fitFiles.length > 0 && (
                <div className="space-y-1.5">
                  <Label>Dispositivo a cui associare i dati</Label>
                  <Select value={target} onValueChange={setTarget}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {realDevices.map((d) => (
                        <SelectItem key={d.id} value={String(d.id)}>
                          {d.alias || d.name}
                        </SelectItem>
                      ))}
                      <SelectItem value="new">Nuovo dispositivo «vívosmart 5»</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground text-xs">
                    Se il bracciale è già collegato all'app viene riconosciuto dal numero di serie scritto nei file; questa scelta vale solo per i file non riconosciuti.
                  </p>
                </div>
              )}
            </div>
          )}

          {step === "running" && (
            <div className="space-y-2">
              <div className="text-muted-foreground flex justify-between text-sm">
                <span>{progress.phase === "store" ? "Lettura e controllo duplicati" : "Elaborazione dei dati"}</span>
                <span className="tabular">
                  {fmtInt(progress.done)}/{fmtInt(progress.total)}
                </span>
              </div>
              <Progress value={(progress.done / progress.total) * 100} />
            </div>
          )}

          {step === "done" && report && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2 font-medium">
                <CheckCircle2Icon className="text-steps size-5" />
                {report.added ? `${fmtInt(report.added)} file nuovi importati` : "Nessun file nuovo: erano già tutti presenti"}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="text-muted-foreground text-xs">Trovati</div>
                  <div className="font-semibold">{fmtInt(report.found)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Già presenti</div>
                  <div className="font-semibold">{fmtInt(report.duplicates)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Non validi</div>
                  <div className="font-semibold">{fmtInt(report.invalid.length)}</div>
                </div>
              </div>
              {report.createdDevice && <p className="text-muted-foreground">Creato il dispositivo «{report.createdDevice.name}»: puoi abbinarlo al bracciale più tardi.</p>}
              {report.invalid.length > 0 && (
                <div className="text-muted-foreground max-h-24 overflow-y-auto text-xs">
                  {report.invalid.slice(0, 20).map((i) => (
                    <div key={i.name}>
                      {i.name.split("/").pop()}: {i.error}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {step === "confirm" && (
              <>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Annulla
                </Button>
                <Button onClick={() => void run()} disabled={!scan?.fitFiles.length}>
                  Importa {scan?.fitFiles.length ? fmtInt(scan.fitFiles.length) : ""} file
                </Button>
              </>
            )}
            {step === "done" && (
              <>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Chiudi
                </Button>
                <Button
                  onClick={() => {
                    setOpen(false);
                    navigate("/");
                  }}
                >
                  Vai alla Home
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
