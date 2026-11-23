import { useState, type FormEvent, type ReactNode } from "react";
import { EyeIcon, EyeOffIcon, Loader2Icon, LogInIcon } from "lucide-react";
import { useAuth } from "@/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api";

export const APP_NAME = "VitaBridge";

/** The centred card of the screens before the app (login, password change). */
export function AuthScreen({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="flex items-center gap-2.5">
        <img src="icon.svg" alt="" className="size-10" />
        <div className="text-xl font-semibold">{APP_NAME}</div>
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

/** A password field with a button to show what was typed (easier on a phone). */
export function PasswordInput({ id, value, onChange, autoComplete, autoFocus }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; autoFocus?: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input id={id} type={visible ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} autoFocus={autoFocus} required className="pr-10" />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-10 items-center justify-center"
        aria-label={visible ? "Nascondi la password" : "Mostra la password"}
      >
        {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
      </button>
    </div>
  );
}

export function LoginPage({ expired }: { expired?: boolean }) {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(errorMessage(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreen title="Accedi" description="Usa il nome utente e la password che ti ha dato il responsabile dello studio.">
      <form onSubmit={submit} className="space-y-4">
        {expired && !error && (
          <Alert>
            <AlertDescription>La sessione è scaduta: accedi di nuovo.</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="username">Nome utente</Label>
          <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required autoFocus />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <PasswordInput id="password" value={password} onChange={setPassword} autoComplete="current-password" />
        </div>
        <Button type="submit" className="w-full" disabled={busy || !username || !password}>
          {busy ? <Loader2Icon className="animate-spin" /> : <LogInIcon />} Accedi
        </Button>
      </form>
    </AuthScreen>
  );
}
