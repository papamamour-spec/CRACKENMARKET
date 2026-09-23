import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useMarket } from "../hooks/useMarket";
import { fmtNum, fmtPct, signClass } from "../lib/format";
import { CommandPalette } from "./CommandPalette";
import { ThemeToggle } from "./ThemeToggle";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  roles?: string[];
}
interface NavGroup {
  title: string;
  items: NavItem[];
}

/** Coquille applicative : barre latérale par domaines, barre supérieure avec recherche globale, bandeau de cotations. */
export function Layout() {
  const { user, logout } = useAuth();
  const { indices, status, connected, quotes, notifications, dismiss } = useMarket();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const tape = Array.from(quotes.values()).sort((a, b) => b.value - a.value);
  const role = user?.role ?? "investor";

  useEffect(() => setDrawer(false), [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const groups: NavGroup[] = [
    {
      title: "Conseil",
      items: [
        { to: "/", label: "Accueil", icon: "⌂" },
        { to: "/conseiller", label: "Mes conseils", icon: "✦" },
        { to: "/conseil", label: role === "sgi" ? "Placements clients" : "Demander un conseil", icon: "✎" },
        { to: "/conseil/analyste", label: "Revue analyste", icon: "☑", roles: ["analyst", "admin"] },
      ],
    },
    {
      title: "Patrimoine",
      items: [
        { to: "/portefeuille", label: "Portefeuille", icon: "▤" },
        { to: "/performance", label: "Performance", icon: "↗" },
        { to: "/sgi", label: role === "sgi" ? "Comptes-titres" : "Ma SGI", icon: "⚑" },
        { to: "/sgi/console", label: "Console SGI", icon: "⚙", roles: ["sgi", "admin"] },
      ],
    },
    {
      title: "Marché",
      items: [
        { to: "/actualites", label: "Signaux & agenda", icon: "◔" },
        { to: "/marche", label: "Cote & screener", icon: "≣" },
        { to: "/classement", label: "Classement", icon: "♛" },
        { to: "/alertes", label: "Suivi & alertes", icon: "☆" },
        { to: "/backtest", label: "Backtest", icon: "⟲" },
      ],
    },
    {
      title: "Compte",
      items: [
        { to: "/profil", label: "Mon profil", icon: "☺" },
        { to: "/compte", label: "Sécurité & API", icon: "⚿" },
      ],
    },
  ];

  return (
    <div className={`shell ${drawer ? "drawer-open" : ""}`}>
      <aside className="sidebar" aria-label="Navigation principale">
        <div className="brand">Cracken<span>Market</span></div>
        {groups.map((g) => {
          const items = g.items.filter((i) => !i.roles || i.roles.includes(role));
          if (!items.length) return null;
          return (
            <div key={g.title} className="nav-group">
              <div className="nav-title">{g.title}</div>
              {items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === "/"} className="nav-item">
                  <span className="nav-icon" aria-hidden>{i.icon}</span>
                  {i.label}
                </NavLink>
              ))}
            </div>
          );
        })}
        <div className="sidebar-foot">
          <span className={`dot ${connected ? (status?.provider === "live" ? "on" : "sim") : ""}`} />
          <span className="muted" style={{ fontSize: 12 }}>{connected ? (status?.provider === "live" ? "Temps réel BRVM" : "Simulation temps réel") : "Reconnexion…"}{status && ` · ${status.open ? "séance ouverte" : "hors séance"}`}</span>
        </div>
      </aside>
      <div className="drawer-backdrop" onClick={() => setDrawer(false)} />
      <div className="content">
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="Menu" onClick={() => setDrawer(true)}>☰</button>
          <button className="search-btn" onClick={() => setPaletteOpen(true)} aria-label="Rechercher">
            <span aria-hidden>⌕</span><span className="search-text">Rechercher une valeur, une page…</span><kbd>⌘K</kbd>
          </button>
          <span className="spacer" />
          {indices.map((i) => (
            <div key={i.name} className="index-pill">
              <span className="label">{i.name}</span>
              <span className="mono">{fmtNum(i.value, 2)}</span>
              <span className={`mono ${signClass(i.changePct)}`}>{fmtPct(i.changePct)}</span>
            </div>
          ))}
          <ThemeToggle />
          <div className="user-menu">
            <span className="avatar" aria-hidden>{(user?.fullName ?? "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}</span>
            <span className="user-name">{user?.fullName}</span>
            <button className="btn sm" onClick={logout}>Déconnexion</button>
          </div>
        </header>
        <div className="ticker">
          <div className="ticker-track">
            {tape.map((q) => (
              <span key={q.symbol} className="ticker-item">
                <b>{q.symbol}</b>
                <span className="mono">{fmtNum(q.price)}</span>
                <span className={signClass(q.changePct)}>{fmtPct(q.changePct)}</span>
              </span>
            ))}
          </div>
        </div>
        <main className="main">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <div className="toasts" aria-live="polite">
        {notifications.slice(0, 4).map((n) => (
          <div key={n.id} className={`toast ${n.kind}`} onClick={() => dismiss(n.id)}>
            {n.message}
          </div>
        ))}
      </div>
    </div>
  );
}
