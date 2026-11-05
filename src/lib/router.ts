import { useSyncExternalStore } from "react";

/** Minimal hash router: works on any static hosting and inside an installed PWA. */
const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};
const getPath = () => window.location.hash.replace(/^#/, "") || "/";

export function usePath(): string {
  return useSyncExternalStore(subscribe, getPath, () => "/");
}

export function navigate(to: string, replace = false) {
  if (replace) window.location.replace(`#${to}`);
  else window.location.hash = to;
  window.scrollTo({ top: 0 });
}

/** match("/workouts/:id", "/workouts/3") -> { id: "3" } */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("?")[0].split("/").filter(Boolean);
  if (p.length !== s.length && !pattern.endsWith("?")) {
    const opt = p[p.length - 1]?.endsWith("?");
    if (!(opt && s.length === p.length - 1)) return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i].replace(/\?$/, "");
    if (seg.startsWith(":")) {
      if (s[i] !== undefined) params[seg.slice(1)] = decodeURIComponent(s[i]);
    } else if (seg !== s[i]) return null;
  }
  return params;
}

export function query(path: string): URLSearchParams {
  return new URLSearchParams(path.split("?")[1] ?? "");
}
