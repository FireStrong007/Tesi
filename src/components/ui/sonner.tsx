/**
 * Lightweight toast system with the same call style as shadcn's Sonner (`toast("…")`, `toast.error("…")`),
 * implemented locally to avoid an extra dependency.
 */
import * as React from "react";
import { CircleCheckIcon, CircleAlertIcon, InfoIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Kind = "default" | "success" | "error";
interface T { id: number; kind: Kind; title: string; description?: string }
let items: T[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function push(kind: Kind, title: string, opts?: { description?: string; duration?: number }) {
  const id = ++seq;
  items = [...items, { id, kind, title, description: opts?.description }].slice(-4);
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, opts?.duration ?? (kind === "error" ? 6000 : 3500));
}

export const toast = Object.assign((title: string, opts?: { description?: string }) => push("default", title, opts), {
  success: (title: string, opts?: { description?: string }) => push("success", title, opts),
  error: (title: string, opts?: { description?: string }) => push("error", title, opts),
});

export function Toaster() {
  const list = React.useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => items);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6 md:items-end">
      {list.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            "bg-popover text-popover-foreground pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border p-3 text-sm shadow-lg animate-in",
            t.kind === "error" && "border-destructive/40",
          )}
        >
          {t.kind === "success" ? <CircleCheckIcon className="text-steps mt-0.5 size-4" /> : t.kind === "error" ? <CircleAlertIcon className="text-destructive mt-0.5 size-4" /> : <InfoIcon className="text-primary mt-0.5 size-4" />}
          <div className="min-w-0">
            <div className="font-medium">{t.title}</div>
            {t.description && <div className="text-muted-foreground mt-0.5 break-words">{t.description}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
