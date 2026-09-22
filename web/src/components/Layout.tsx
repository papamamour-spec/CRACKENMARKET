import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useMarket } from "../hooks/useMarket";
import { fmtNum, fmtPct, signClass } from "../lib/format";
import { ThemeToggle } from "./ThemeToggle";

export function Layout() {
  const { user, logout } = useAuth();
  const { indices, status, connected, quotes, notifications, dismiss } = useMarket();
  const tape = Array.from(quotes.values()).sort((a, b) => b.value - a.value);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Cracken<span>Market</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end>Tableau de bord</NavLink>
          <NavLink to="/marche">Marché</NavLink>
          <NavLink to="/conseiller">Conseiller</NavLink>
          <NavLink to="/portefeuille">Portefeuille</NavLink>
          <NavLink to="/performance">Performance</NavLink>
          <NavLink to="/actualites">Signaux & agenda</NavLink>
          <NavLink to="/classement">Classement</NavLink>
          <NavLink to="/alertes">Suivi & alertes</NavLink>
          <NavLink to="/backtest">Backtest</NavLink>
          <NavLink to="/profil">Mon profil</NavLink>
          <NavLink to="/compte">Compte</NavLink>
        </nav>
        {indices.map((i) => (
          <div key={i.name} className="kpi" style={{ minWidth: 120 }}>
            <span className="label">{i.name}</span>
            <span className="mono" style={{ fontWeight: 600 }}>
              {fmtNum(i.value, 2)} <span className={signClass(i.changePct)}>{fmtPct(i.changePct)}</span>
            </span>
          </div>
        ))}
        <span className="status-pill" title={status?.provider === "live" ? "Cours officiels BRVM" : "Flux simulé (source BRVM injoignable ou désactivée)"}>
          <span className={`dot ${connected ? (status?.provider === "live" ? "on" : "sim") : ""}`} />
          {connected ? (status?.provider === "live" ? "Temps réel BRVM" : "Simulation temps réel") : "Reconnexion…"}
          {status && <span>· {status.open ? "Séance ouverte" : "Hors séance"}</span>}
        </span>
        <ThemeToggle />
        <span className="muted" style={{ fontSize: 12 }}>
          {user?.fullName} <button className="btn sm" onClick={logout} style={{ marginLeft: 6 }}>Déconnexion</button>
        </span>
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
      <div className="toasts">
        {notifications.slice(0, 4).map((n) => (
          <div key={n.id} className={`toast ${n.kind}`} onClick={() => dismiss(n.id)}>
            {n.message}
          </div>
        ))}
      </div>
    </div>
  );
}
