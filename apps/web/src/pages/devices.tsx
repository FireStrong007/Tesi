/**
 * The participant's devices as the study's server knows them: model, battery, last measurement and
 * last upload from the phone. Informative only: the app never talks to the band.
 */
import { BatteryFullIcon, BatteryLowIcon, BatteryMediumIcon, SmartphoneIcon, TriangleAlertIcon, WatchIcon } from "lucide-react";
import { useApp, type DeviceInfo } from "@/app-context";
import { EmptyState, PageBody, PageHeader } from "@/components/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDateTime, fmtRelative } from "@bridge/core/format";
import { SyncButton, SyncLine } from "@/pages/dashboard";

/** after this long without an upload the phone probably stopped sending */
const STALE_UPLOAD_MS = 24 * 3600_000;

/** "GARMIN_VIVOSMART_5" -> "Garmin vivosmart 5" when the device has no better name */
const humanType = (t: string | null) => (t ? t.toLowerCase().split("_").map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(" ") : null);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function Battery({ d }: { d: DeviceInfo }) {
  if (d.battery == null) return <>–</>;
  const Icon = d.battery >= 60 ? BatteryFullIcon : d.battery >= 25 ? BatteryMediumIcon : BatteryLowIcon;
  return (
    <span className="flex items-center gap-1.5">
      <Icon className={d.battery < 25 ? "text-destructive size-4" : "text-muted-foreground size-4"} />
      <span className="tabular font-medium">{d.battery}%</span>
      {d.battery_at && <span className="text-muted-foreground text-xs">({fmtRelative(d.battery_at / 1000)})</span>}
    </span>
  );
}

function DeviceCard({ d, showBattery }: { d: DeviceInfo; showBattery: boolean }) {
  const stale = d.last_successful_upload_at != null && Date.now() - d.last_successful_upload_at > STALE_UPLOAD_MS;
  const title = d.name || humanType(d.type_name) || `Dispositivo ${d.id}`;
  const detail = [d.manufacturer, humanType(d.type_name) !== title ? humanType(d.type_name) : null, d.model ? `modello ${d.model}` : null, d.firmware_version ? `firmware ${d.firmware_version}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <WatchIcon className="size-4" /> {title}
        </CardTitle>
        {detail && <CardDescription>{detail}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {showBattery && (
            <Field label="Batteria">
              <Battery d={d} />
            </Field>
          )}
          <Field label="Ultima misura">{d.last_measurement_at ? fmtDateTime(d.last_measurement_at / 1000) : "–"}</Field>
          <Field label="Ultimo caricamento dal telefono">{d.last_successful_upload_at ? `${fmtDateTime(d.last_successful_upload_at / 1000)} (${fmtRelative(d.last_successful_upload_at / 1000)})` : "mai"}</Field>
        </div>
        {stale && (
          <Alert>
            <TriangleAlertIcon />
            <AlertDescription>Il telefono non invia dati da più di un giorno: controlla che l'app del telefono sia aperta e collegata al bracciale.</AlertDescription>
          </Alert>
        )}
        {d.last_successful_upload_at == null && (
          <Alert>
            <AlertDescription>Il server non ha ancora ricevuto dati da questo dispositivo.</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

export function DevicesPage() {
  const { devices } = useApp();
  // only Garmin bands report their battery (BATTERY_LEVEL)
  const showBattery = devices.some((d) => d.battery != null) || devices.some((d) => d.manufacturer === "Garmin");
  return (
    <>
      <PageHeader title="Dispositivi" subtitle="Come li vede il server dello studio" actions={<SyncButton />} />
      <PageBody>
        <SyncLine />
        <Card className="gap-2 py-4">
          <CardContent className="text-muted-foreground flex gap-3 text-sm">
            <SmartphoneIcon className="mt-0.5 size-4 shrink-0" />
            <p>
              I dati passano dal bracciale al telefono, e dal telefono al server dello studio qualche volta al giorno. Questa app li legge dal server: se mancano dati
              recenti, guarda qui quando il telefono li ha inviati l'ultima volta.
            </p>
          </CardContent>
        </Card>
        {devices.length ? (
          devices.map((d) => <DeviceCard key={d.id} d={d} showBattery={showBattery} />)
        ) : (
          <EmptyState icon={<WatchIcon />} title="Nessun dispositivo">
            Sul server dello studio non c'è ancora nessun dispositivo collegato al tuo account. Rivolgiti al responsabile dello studio.
          </EmptyState>
        )}
      </PageBody>
    </>
  );
}
