import { useState, type FormEvent } from "react";
import { Loader2Icon } from "lucide-react";
import { useAuth, useMe } from "@/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api";
import { AuthScreen, PasswordInput } from "@/pages/login";

/** the same rule as the server (packages/server/src/auth/passwords.ts) */
export const MIN_PASSWORD_LENGTH = 10;

/** Current password, new one twice. Used for the forced change and from the settings. */
export function ChangePasswordForm({ onDone, submitLabel = "Cambia password" }: { onDone?: () => void; submitLabel?: string }) {
  const { changePassword } = useAuth();
  const me = useMe();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem =
    next && next.length < MIN_PASSWORD_LENGTH ? `Almeno ${MIN_PASSWORD_LENGTH} caratteri.` : again && next !== again ? "Le due password nuove non coincidono." : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {/* lets password managers save the new password with the right username */}
      <input type="text" name="username" autoComplete="username" value={me.account.username} readOnly hidden />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="current-password">Password attuale</Label>
        <PasswordInput id="current-password" value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />
      </div>
      <div className="space-y-2">
        <Label htmlFor="new-password">Nuova password</Label>
        <PasswordInput id="new-password" value={next} onChange={setNext} autoComplete="new-password" />
        <p className="text-muted-foreground text-xs">Almeno {MIN_PASSWORD_LENGTH} caratteri. Una frase di più parole è facile da ricordare e difficile da indovinare.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="new-password-again">Ripeti la nuova password</Label>
        <PasswordInput id="new-password-again" value={again} onChange={setAgain} autoComplete="new-password" />
      </div>
      {problem && <p className="text-destructive text-sm">{problem}</p>}
      <Button type="submit" className="w-full" disabled={busy || !current || !next || !again || !!problem}>
        {busy && <Loader2Icon className="animate-spin" />} {submitLabel}
      </Button>
    </form>
  );
}

/** First login with a temporary password: the change comes before anything else. */
export function ForcedPasswordChangePage() {
  const me = useMe();
  const { logout } = useAuth();
  return (
    <AuthScreen
      title="Scegli una nuova password"
      description={
        <>
          Hai effettuato l'accesso come <strong>{me.account.username}</strong> con una password temporanea. Per continuare scegline una tua.
        </>
      }
    >
      <ChangePasswordForm submitLabel="Salva e continua" />
      <Button variant="ghost" className="mt-2 w-full" onClick={() => void logout()}>
        Esci
      </Button>
    </AuthScreen>
  );
}
