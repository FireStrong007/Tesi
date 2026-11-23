import { useState } from "react";
import { KeyRoundIcon, LogOutIcon } from "lucide-react";
import { useAuth, useMe } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { ChangePasswordForm } from "@/pages/change-password";

/** The logged-in participant's account: name, password change, logout. */
export function AccountCard() {
  const me = useMe();
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>
          Hai effettuato l'accesso come <span className="text-foreground font-medium">{me.account.username}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setOpen(true)}>
          <KeyRoundIcon /> Cambia password
        </Button>
        <Button variant="outline" onClick={() => void logout()}>
          <LogOutIcon /> Esci
        </Button>
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cambia password</DialogTitle>
            <DialogDescription>Gli altri dispositivi collegati con questo account verranno disconnessi.</DialogDescription>
          </DialogHeader>
          <ChangePasswordForm
            onDone={() => {
              setOpen(false);
              toast.success("Password cambiata");
            }}
          />
        </DialogContent>
      </Dialog>
    </Card>
  );
}
