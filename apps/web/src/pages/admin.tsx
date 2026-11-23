/**
 * The administrator's area: the participants of the research database (code, devices, last
 * measurement and upload: no health data), their accounts, the data copy's state and the log of
 * the administrators' actions.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { CheckIcon, CopyIcon, KeyRoundIcon, Loader2Icon, LogOutIcon, RefreshCwIcon, SearchIcon, ShieldCheckIcon, UserPlusIcon, UserRoundCheckIcon, UserRoundXIcon } from "lucide-react";
import { fmtDateTime } from "@bridge/core/format";
import { useAuth, useMe } from "@/auth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { apiGet, apiPost, errorMessage } from "@/lib/api";
import { ChangePasswordForm } from "@/pages/change-password";

interface AdminAccount {
  id: number;
  username: string;
  participantId: number | null;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}
type Device = Record<string, string | number | null>;
interface Participant {
  id: number;
  code: string;
  createdAt: number;
  devices: Device[];
  lastMeasurementAt: number | null;
  lastUploadAt: number | null;
  suggestedUsername: string;
  account: AdminAccount | null;
}
interface Status {
  app: { id: string; label: string };
  data: { mode: "file" | "backup"; takenAt: number | null; lastAttemptAt: number | null; lastError: string | null; refreshing: boolean };
  accounts: { participants: number; admins: number };
}
interface AuditEntry {
  id: number;
  at: number;
  actorUsername: string;
  action: "account_created" | "password_reset" | "account_disabled" | "account_enabled";
  targetUsername: string | null;
}

const ACTION_LABEL: Record<AuditEntry["action"], string> = {
  account_created: "ha creato l'account",
  password_reset: "ha reimpostato la password di",
  account_disabled: "ha disattivato",
  account_enabled: "ha riattivato",
};

/** server times are in milliseconds */
const when = (ms: number | null) => (ms == null ? "–" : fmtDateTime(ms / 1000));
const deviceLabel = (d: Device) => [d.name, d.model ? `modello ${d.model}` : null, d.firmware_version ? `firmware ${d.firmware_version}` : null].filter(Boolean).join(" · ");

function AccountBadge({ a }: { a: AdminAccount }) {
  if (a.disabled) return <Badge variant="destructive">Disattivato</Badge>;
  if (a.mustChangePassword) return <Badge variant="outline">In attesa del primo accesso</Badge>;
  return <Badge variant="secondary">Attivo</Badge>;
}

/** Shown once, right after creation or reset: the server never gives it again. */
function TemporaryPasswordDialog({ shown, onClose }: { shown: { username: string; password: string; created: boolean } | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [shown]);
  const copy = async () => {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.password);
      setCopied(true);
    } catch {
      toast.error("Copia non riuscita: seleziona la password e copiala a mano.");
    }
  };
  return (
    <Dialog open={!!shown} onOpenChange={(o) => !o && onClose()}>
      <DialogContent onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{shown?.created ? "Account creato" : "Password reimpostata"}</DialogTitle>
          <DialogDescription>Consegna queste credenziali al partecipante. Al primo accesso dovrà scegliere una password sua.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="bg-muted rounded-lg p-3 text-sm">
            <div className="text-muted-foreground text-xs">Nome utente</div>
            <div className="font-mono text-base font-semibold select-all">{shown?.username}</div>
            <div className="text-muted-foreground mt-2 text-xs">Password temporanea</div>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 font-mono text-lg font-semibold tracking-wider break-all select-all">{shown?.password}</div>
              <Button size="sm" variant="outline" onClick={() => void copy()}>
                {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copiata" : "Copia"}
              </Button>
            </div>
          </div>
          <Alert>
            <AlertDescription>Annotala ora: non verrà più mostrata. Se va persa, reimposta di nuovo la password.</AlertDescription>
          </Alert>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Ho annotato la password</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateAccountDialog({ participant, onClose, onCreated }: { participant: Participant | null; onClose: () => void; onCreated: (username: string, password: string) => void }) {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setUsername(participant?.suggestedUsername ?? "");
    setError(null);
  }, [participant]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!participant) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<{ account: AdminAccount; temporaryPassword: string }>("admin/accounts", { participantId: participant.id, username });
      onCreated(r.account.username, r.temporaryPassword);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!participant} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Crea un account per {participant?.code}</DialogTitle>
            <DialogDescription>Il partecipante vedrà solo i propri dati. Riceverai una password temporanea da consegnargli.</DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="new-username">Nome utente</Label>
            <Input id="new-username" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
            <p className="text-muted-foreground text-xs">3–40 caratteri: lettere minuscole, cifre, punto, trattino o trattino basso.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Annulla
            </Button>
            <Button type="submit" disabled={busy || !username}>
              {busy ? <Loader2Icon className="animate-spin" /> : <UserPlusIcon />} Crea account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Confirm = { kind: "reset" | "disable" | "enable"; participant: Participant };

const CONFIRM_TEXT: Record<Confirm["kind"], { title: (u: string) => string; body: string; button: string }> = {
  reset: {
    title: (u) => `Reimpostare la password di ${u}?`,
    body: "La password attuale smette di funzionare e il partecipante viene disconnesso da tutti i dispositivi. Riceverai una nuova password temporanea.",
    button: "Reimposta password",
  },
  disable: {
    title: (u) => `Disattivare ${u}?`,
    body: "Il partecipante viene disconnesso subito e non può più accedere finché non riattivi l'account. I suoi dati sul server non cambiano.",
    button: "Disattiva",
  },
  enable: { title: (u) => `Riattivare ${u}?`, body: "Il partecipante potrà di nuovo accedere con la sua password.", button: "Riattiva" },
};

function ConfirmDialog({ confirm, onClose, onDone }: { confirm: Confirm | null; onClose: () => void; onDone: (r: { account: AdminAccount; temporaryPassword?: string }, kind: Confirm["kind"]) => void }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!confirm?.participant.account) return;
    setBusy(true);
    try {
      const path = { reset: "reset-password", disable: "disable", enable: "enable" }[confirm.kind];
      onDone(await apiPost(`admin/accounts/${confirm.participant.account.id}/${path}`), confirm.kind);
    } catch (err) {
      toast.error(errorMessage(err));
      onClose();
    } finally {
      setBusy(false);
    }
  };
  const t = confirm && CONFIRM_TEXT[confirm.kind];
  return (
    <Dialog open={!!confirm} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t?.title(confirm!.participant.account?.username ?? "")}</DialogTitle>
          <DialogDescription>{t?.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Annulla
          </Button>
          <Button variant={confirm?.kind === "disable" ? "destructive" : "default"} onClick={() => void run()} disabled={busy}>
            {busy && <Loader2Icon className="animate-spin" />} {t?.button}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="truncate text-sm">{children}</div>
    </div>
  );
}

function ParticipantItem({ p, onCreate, onConfirm }: { p: Participant; onCreate: () => void; onConfirm: (kind: Confirm["kind"]) => void }) {
  const a = p.account;
  return (
    <li className="grid gap-3 py-4 md:grid-cols-[9rem_1fr_1fr_1fr_auto] md:items-center">
      <div className="flex items-center justify-between gap-2 md:block">
        <div className="font-mono font-semibold">{p.code}</div>
        <div className="md:mt-1">{a ? <AccountBadge a={a} /> : <Badge variant="outline">Senza account</Badge>}</div>
      </div>
      <Field label={p.devices.length === 1 ? "Dispositivo" : `Dispositivi (${p.devices.length})`}>
        {p.devices.length ? p.devices.map((d) => <div key={String(d.id)} className="truncate">{deviceLabel(d)}</div>) : "Nessuno"}
      </Field>
      <div className="grid grid-cols-2 gap-3 md:contents">
        <Field label="Ultima misura">{when(p.lastMeasurementAt)}</Field>
        <Field label="Ultimo caricamento">{when(p.lastUploadAt)}</Field>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        {a ? (
          <>
            <div className="text-muted-foreground mr-auto text-xs md:mr-2 md:text-right">
              <span className="text-foreground font-medium">{a.username}</span>
              <br />
              {a.lastLoginAt ? `ultimo accesso ${when(a.lastLoginAt)}` : "mai entrato"}
            </div>
            <Button size="sm" variant="outline" onClick={() => onConfirm("reset")} aria-label={`Reimposta la password di ${a.username}`}>
              <KeyRoundIcon /> Password
            </Button>
            {a.disabled ? (
              <Button size="sm" variant="outline" onClick={() => onConfirm("enable")}>
                <UserRoundCheckIcon /> Riattiva
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => onConfirm("disable")}>
                <UserRoundXIcon /> Disattiva
              </Button>
            )}
          </>
        ) : (
          <Button size="sm" onClick={onCreate}>
            <UserPlusIcon /> Crea account
          </Button>
        )}
      </div>
    </li>
  );
}

export function AdminApp() {
  const me = useMe();
  const { logout } = useAuth();
  const [participants, setParticipants] = useState<Participant[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState<Participant | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [shown, setShown] = useState<{ username: string; password: string; created: boolean } | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, p, a] = await Promise.all([
        apiGet<Status>("admin/status"),
        apiGet<{ participants: Participant[] }>("admin/participants").catch((e) => {
          setLoadError(errorMessage(e));
          return null;
        }),
        apiGet<{ entries: AuditEntry[] }>("admin/audit"),
      ]);
      setStatus(s);
      if (p) {
        setParticipants(p.participants);
        setLoadError(null);
      }
      setAudit(a.entries);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (participants ?? []).filter((p) => !q || p.code.toLowerCase().includes(q) || p.account?.username.includes(q));
  }, [participants, query]);
  const withAccount = (participants ?? []).filter((p) => p.account).length;

  return (
    <div className="min-h-dvh">
      <header className="bg-card sticky top-0 z-30 border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 md:px-8">
          <img src="icon.svg" alt="" className="size-8" />
          <div className="min-w-0 flex-1">
            <div className="truncate leading-tight font-semibold">{me.app.label}</div>
            <div className="text-muted-foreground flex items-center gap-1 text-xs">
              <ShieldCheckIcon className="size-3" /> Amministrazione · {me.account.username}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setPasswordOpen(true)}>
            <KeyRoundIcon /> <span className="hidden sm:inline">Cambia password</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => void logout()}>
            <LogOutIcon /> Esci
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-4 md:px-8 md:py-8">
        <Card>
          <CardHeader>
            <CardTitle>Dati dello studio</CardTitle>
            <CardDescription>
              {status?.data.mode === "backup" ? "Copia scaricata periodicamente dal server dello studio, in sola lettura." : "File locale aperto in sola lettura."}
            </CardDescription>
            <CardAction>
              <Button variant="ghost" size="icon" onClick={() => void load()} aria-label="Aggiorna">
                <RefreshCwIcon />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label="Copia dei dati del">{when(status?.data.takenAt ?? null)}</Field>
              <Field label="Ultimo controllo">{when(status?.data.lastAttemptAt ?? null)}</Field>
              <Field label="Partecipanti">{participants ? participants.length : "–"}</Field>
              <Field label="Con account">{participants ? withAccount : "–"}</Field>
            </div>
            {status?.data.lastError && (
              <Alert variant="destructive">
                <AlertTitle>L'ultimo aggiornamento non è riuscito</AlertTitle>
                <AlertDescription>{status.data.lastError}. Resta in uso la copia precedente.</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Partecipanti</CardTitle>
            <CardDescription>Codici e dispositivi del database dello studio. Da qui non si vedono i dati sanitari.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="relative mb-2">
              <SearchIcon className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cerca codice o nome utente" className="pl-9" aria-label="Cerca partecipante" />
            </div>
            {loadError && (
              <Alert variant="destructive" className="my-2">
                <AlertDescription>{loadError}</AlertDescription>
              </Alert>
            )}
            {!participants && !loadError && <Loader2Icon className="text-muted-foreground mx-auto my-6 size-5 animate-spin" />}
            {participants && !visible.length && <p className="text-muted-foreground py-6 text-center text-sm">{participants.length ? "Nessun partecipante corrisponde alla ricerca." : "Il database dello studio non ha ancora partecipanti."}</p>}
            <ul className="divide-y">
              {visible.map((p) => (
                <ParticipantItem key={p.id} p={p} onCreate={() => setCreating(p)} onConfirm={(kind) => setConfirm({ kind, participant: p })} />
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Registro delle azioni</CardTitle>
            <CardDescription>Account creati, password reimpostate, account disattivati e riattivati. Le ultime 200 azioni.</CardDescription>
          </CardHeader>
          <CardContent>
            {audit.length ? (
              <ul className="divide-y text-sm">
                {audit.map((e) => (
                  <li key={e.id} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-3">
                    <span className="text-muted-foreground shrink-0 tabular-nums sm:w-40">{when(e.at)}</span>
                    <span>
                      <span className="font-medium">{e.actorUsername}</span> {ACTION_LABEL[e.action]} <span className="font-medium">{e.targetUsername}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">Nessuna azione registrata.</p>
            )}
          </CardContent>
        </Card>
      </main>

      <CreateAccountDialog
        participant={creating}
        onClose={() => setCreating(null)}
        onCreated={(username, password) => {
          setCreating(null);
          setShown({ username, password, created: true });
          void load();
        }}
      />
      <ConfirmDialog
        confirm={confirm}
        onClose={() => setConfirm(null)}
        onDone={(r, kind) => {
          setConfirm(null);
          if (kind === "reset" && r.temporaryPassword) setShown({ username: r.account.username, password: r.temporaryPassword, created: false });
          else toast.success(kind === "disable" ? `${r.account.username} disattivato` : `${r.account.username} riattivato`);
          void load();
        }}
      />
      <TemporaryPasswordDialog shown={shown} onClose={() => setShown(null)} />
      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cambia la tua password</DialogTitle>
            <DialogDescription>Le altre sessioni aperte con questo account verranno chiuse.</DialogDescription>
          </DialogHeader>
          <ChangePasswordForm
            onDone={() => {
              setPasswordOpen(false);
              toast.success("Password cambiata");
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
