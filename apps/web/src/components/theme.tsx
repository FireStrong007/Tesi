import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";
const KEY = "vitabridge-theme";

function read(): Theme {
  try {
    return (localStorage.getItem(KEY) as Theme) || "system";
  } catch {
    return "system";
  }
}

function apply(t: Theme) {
  const dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function initTheme() {
  apply(read());
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => apply(read()));
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => apply(theme), [theme]);
  return [
    theme,
    (t) => {
      try {
        localStorage.setItem(KEY, t);
      } catch {
        /* ignore */
      }
      setTheme(t);
    },
  ];
}
