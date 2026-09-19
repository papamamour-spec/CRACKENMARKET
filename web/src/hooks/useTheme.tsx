import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "dark" | "light";
const KEY = "cm_theme";

interface ThemeCtx {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* stockage indisponible */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* stockage indisponible */
    }
  }, [theme]);
  const value = useMemo<ThemeCtx>(() => ({ theme, setTheme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) }), [theme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("ThemeProvider manquant");
  return c;
}

/** Couleurs des graphiques lightweight-charts selon le thème. */
export function chartColors(theme: Theme) {
  return theme === "light"
    ? { background: "#ffffff", text: "#5b6b85", grid: "#e6ebf3", border: "#d5dce8", up: "#16a34a", down: "#dc2626", accent: "#0284c7", warn: "#d97706", purple: "#7c3aed", neutral: "#94a3b8" }
    : { background: "#101a2e", text: "#8b9bb8", grid: "#1a2740", border: "#223050", up: "#22c55e", down: "#ef4444", accent: "#38bdf8", warn: "#f59e0b", purple: "#a78bfa", neutral: "#64748b" };
}
