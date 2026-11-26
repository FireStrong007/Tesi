import { Loader2Icon, RefreshCwIcon, ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";
import { AppProvider, type StartState } from "@/app-context";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "@/auth";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { sharedDbClient } from "@/lib/db/client";
import { BRAND } from "@/brand";
import { Toaster } from "@/components/ui/sonner";
import { match, usePath } from "@/lib/router";
import { AdminApp } from "@/pages/admin";
import { ForcedPasswordChangePage } from "@/pages/change-password";
import { ChartsPage } from "@/pages/charts";
import { DashboardPage } from "@/pages/dashboard";
import { DevicesPage } from "@/pages/devices";
import { EcgPage } from "@/pages/ecg";
import { LoginPage } from "@/pages/login";
import { SettingsPage } from "@/pages/settings";

function Routes() {
  const path = usePath();
  if (match("/devices", path)) return <DevicesPage />;
  if (match("/charts", path)) return <ChartsPage />;
  if (BRAND.ecg && match("/ecg", path)) return <EcgPage />;
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

/**
 * The account no longer names the same participant in the data («da verificare») or was made
 * before the codes were kept («da ricreare»): no data, and the copy on this device is erased (it
 * could be someone else's).
 */
function AccountProblem({ link }: { link: "review" | "recreate" }) {
  const { logout } = useAuth();
  useEffect(() => {
    const db = sharedDbClient();
    void db
      .init()
      .then(() => db.erase())
      .catch((e) => console.error("Cancellazione dei dati locali non riuscita", e));
  }, []);
  return (
    <Centered>
      <ShieldAlertIcon className="text-destructive size-6" />
      <div className="font-semibold">{link === "recreate" ? "Account da ricreare" : "Account da verificare"}</div>
      <div className="text-muted-foreground max-w-sm text-sm">
        {link === "recreate"
          ? "Questo account non è più valido e va ricreato: chiedi un nuovo account al responsabile dello studio."
          : "Il tuo account è da verificare: il responsabile dello studio deve controllarlo. Nel frattempo i dati non sono disponibili."}
      </div>
      <Button variant="outline" onClick={() => void logout()}>
        Esci
      </Button>
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

/** This build is one app (brand.ts), the server another: say so, nothing else would work. */
function WrongServer({ server }: { server: string }) {
  const names: Record<string, string> = { vitabridge: "VitaBridge", heartbridge: "HeartBridge" };
  return (
    <Centered>
      <TriangleAlertIcon className="text-destructive size-6" />
      <div className="font-semibold">App e server non corrispondono</div>
      <div className="text-muted-foreground max-w-md text-sm">
        Questa è l'app {BRAND.name}, ma il server a cui si collega è {names[server] ?? server}. Apri l'indirizzo di {BRAND.name} che ti ha dato il responsabile dello studio.
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
  const serverApp = state.status === "ready" ? state.me.app.id : state.status === "anonymous" ? state.serverApp : undefined;
  if (serverApp && serverApp !== BRAND.id) return <WrongServer server={serverApp} />;
  if (state.status === "anonymous") return <LoginPage expired={state.reason === "expired"} />;
  if (state.me.account.mustChangePassword) return <ForcedPasswordChangePage />;
  if (state.me.account.role === "admin") return <AdminApp />;
  const link = state.me.account.link ?? "ok";
  return link === "ok" ? <ParticipantApp /> : <AccountProblem link={link} />;
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
