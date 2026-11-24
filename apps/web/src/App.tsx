import { Loader2Icon, RefreshCwIcon, ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";
import { AppProvider, type StartState } from "@/app-context";
import { AuthProvider, useAuth } from "@/auth";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Toaster } from "@/components/ui/sonner";
import { match, usePath } from "@/lib/router";
import { AdminApp } from "@/pages/admin";
import { ForcedPasswordChangePage } from "@/pages/change-password";
import { ChartsPage } from "@/pages/charts";
import { DashboardPage } from "@/pages/dashboard";
import { DevicesPage } from "@/pages/devices";
import { LoginPage } from "@/pages/login";
import { SettingsPage } from "@/pages/settings";

function Routes() {
  const path = usePath();
  if (match("/devices", path)) return <DevicesPage />;
  if (match("/charts", path)) return <ChartsPage />;
  if (match("/settings", path)) return <SettingsPage />;
  return <DashboardPage />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <img src="icon.svg" alt="" className="size-14" />
      {children}
    </div>
  );
}

/** Before the data: opening the copy, the first download, or why it could not start. */
function StartScreen({ error, progress, syncError, retry }: StartState) {
  const { logout } = useAuth();
  if (error)
    return (
      <Centered>
        <TriangleAlertIcon className="text-destructive size-6" />
        <div className="font-semibold">Impossibile aprire i dati sul dispositivo</div>
        <div className="text-muted-foreground max-w-sm text-sm">{error.message}</div>
      </Centered>
    );
  if (syncError)
    return (
      <Centered>
        <TriangleAlertIcon className="text-destructive size-6" />
        <div className="font-semibold">Non è stato possibile scaricare i tuoi dati</div>
        <div className="text-muted-foreground max-w-sm text-sm">{syncError}</div>
        <div className="flex gap-2">
          <Button onClick={retry}>
            <RefreshCwIcon /> Riprova
          </Button>
          <Button variant="ghost" onClick={() => void logout()}>
            Esci
          </Button>
        </div>
      </Centered>
    );
  const pct = progress && progress.expected ? Math.round((progress.rows / progress.expected) * 100) : null;
  return (
    <Centered>
      <Loader2Icon className="text-muted-foreground size-6 animate-spin" />
      <div className="font-semibold">{progress ? "Scaricamento dei tuoi dati…" : "Apertura…"}</div>
      {progress && (
        <div className="w-64 space-y-2">
          <Progress value={pct ?? 0} />
          <div className="text-muted-foreground text-xs tabular-nums">{pct != null ? `${pct}%` : `${progress.rows} righe`}</div>
        </div>
      )}
    </Centered>
  );
}

/** The participant's app: their data, read from the server and kept on the device. */
function ParticipantApp() {
  return (
    <AppProvider fallback={(s) => <StartScreen {...s} />}>
      <AppShell>
        <Routes />
      </AppShell>
    </AppProvider>
  );
}

/**
 * The app needs a secure context (https, or localhost while developing): OPFS, the service worker
 * and the session cookie depend on it. Opened over http from a network address, say so clearly.
 */
function InsecureContext() {
  return (
    <Centered>
      <ShieldAlertIcon className="text-destructive size-6" />
      <div className="font-semibold">Apri l'app con un indirizzo https</div>
      <div className="text-muted-foreground max-w-md text-sm">
        Questa pagina è aperta da <span className="font-mono">{location.origin}</span>, senza connessione sicura: il browser non permette di salvare i dati sul
        dispositivo né di mantenere l'accesso. Usa l'indirizzo https che ti ha dato il responsabile dello studio
        {location.hostname !== "localhost" && " (in sviluppo: http://localhost)"}.
      </div>
    </Centered>
  );
}

/** Login first; then the screen of the account's role. */
function Gate() {
  const { state, reload } = useAuth();
  if (state.status === "loading")
    return (
      <Centered>
        <Loader2Icon className="text-muted-foreground size-6 animate-spin" />
      </Centered>
    );
  if (state.status === "offline")
    return (
      <Centered>
        <TriangleAlertIcon className="text-destructive size-6" />
        <div className="font-semibold">Il server non risponde</div>
        <div className="text-muted-foreground max-w-sm text-sm">{state.message}</div>
        <Button onClick={() => void reload()}>Riprova</Button>
      </Centered>
    );
  if (state.status === "anonymous") return <LoginPage expired={state.reason === "expired"} />;
  if (state.me.account.mustChangePassword) return <ForcedPasswordChangePage />;
  return state.me.account.role === "admin" ? <AdminApp /> : <ParticipantApp />;
}

export default function App() {
  if (!window.isSecureContext) return <InsecureContext />;
  return (
    <AuthProvider>
      <Gate />
      <Toaster />
    </AuthProvider>
  );
}
