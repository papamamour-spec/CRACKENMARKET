import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { QuoteTable } from "../components/QuoteTable";
import { RecommendationCard } from "../components/RecommendationCard";
import { useMarket } from "../hooks/useMarket";
import { api } from "../lib/api";
import { compact, fmtFcfa, fmtNum, fmtPct, signClass } from "../lib/format";
import type { BehaviorProfile, PortfolioSummary, Recommendation } from "../lib/types";

export function DashboardPage() {
  const { quotes, indices, status } = useMarket();
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [profile, setProfile] = useState<BehaviorProfile | null>(null);
  const [sectors, setSectors] = useState<{ sector: string; count: number; avgChangePct: number; value: number }[]>([]);

  useEffect(() => {
    api<PortfolioSummary>("/portfolio").then(setSummary).catch(() => {});
    api<{ profile: BehaviorProfile; recommendations: Recommendation[] }>("/advisor/recommendations")
      .then((r) => {
        setProfile(r.profile);
        setRecs(r.recommendations.filter((x) => x.action === "ACHAT FORT" || x.action === "ACHAT").slice(0, 3));
      })
      .catch(() => {});
    const load = () => api<{ summary: typeof sectors }>("/market/sectors").then((r) => setSectors(r.summary)).catch(() => {});
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  const all = Array.from(quotes.values());
  const gainers = [...all].sort((a, b) => b.changePct - a.changePct).slice(0, 5);
  const losers = [...all].sort((a, b) => a.changePct - b.changePct).slice(0, 5);
  const active = [...all].sort((a, b) => b.value - a.value).slice(0, 8);
  const totalValue = all.reduce((a, q) => a + q.value, 0);
  const totalVolume = all.reduce((a, q) => a + q.volume, 0);
  const upCount = all.filter((q) => q.change > 0).length;
  const downCount = all.filter((q) => q.change < 0).length;

  return (
    <div className="grid">
      <div className="grid grid-3">
        {indices.map((i) => (
          <div key={i.name} className="card kpi">
            <span className="label">{i.name}</span>
            <span className="value">{fmtNum(i.value, 2)}</span>
            <span className={`sub ${signClass(i.changePct)}`}>{fmtPct(i.changePct)} aujourd'hui</span>
          </div>
        ))}
        <div className="card kpi">
          <span className="label">Capitaux échangés</span>
          <span className="value">{compact(totalValue)} FCFA</span>
          <span className="sub muted">{fmtNum(totalVolume)} titres · {upCount} ▲ / {downCount} ▼</span>
        </div>
        <div className="card kpi">
          <span className="label">Mon portefeuille</span>
          <span className="value">{summary ? fmtFcfa(summary.totalValue) : "—"}</span>
          {summary && <span className={`sub ${signClass(summary.totalPnl)}`}>{fmtPct(summary.totalPnlPct)} depuis l'ouverture du compte</span>}
        </div>
      </div>

      {profile && (
        <div className="card row">
          <span>Profil <b>{profile.style}</b> · discipline <b>{profile.disciplineScore}/100</b></span>
          {profile.biases.length > 0 && <span style={{ color: "var(--warn)" }}>⚠ {profile.biases.length} biais comportemental{profile.biases.length > 1 ? "aux" : ""} détecté{profile.biases.length > 1 ? "s" : ""}</span>}
          <span className="spacer" />
          <Link to="/conseiller" className="btn sm primary">Voir mes conseils</Link>
        </div>
      )}

      <div className="two-col">
        <div className="card">
          <div className="card-head"><h2>Valeurs les plus actives</h2><Link to="/marche">Toute la cote →</Link></div>
          <QuoteTable rows={active} compactMode />
        </div>
        <div className="grid">
          <div className="card">
            <h3>Plus fortes hausses</h3>
            <table><tbody>{gainers.map((q) => <tr key={q.symbol}><td><Link to={`/valeur/${q.symbol}`} className="sym">{q.symbol}</Link></td><td className="mono">{fmtNum(q.price)}</td><td className={`mono ${signClass(q.changePct)}`}>{fmtPct(q.changePct)}</td></tr>)}</tbody></table>
          </div>
          <div className="card">
            <h3>Plus fortes baisses</h3>
            <table><tbody>{losers.map((q) => <tr key={q.symbol}><td><Link to={`/valeur/${q.symbol}`} className="sym">{q.symbol}</Link></td><td className="mono">{fmtNum(q.price)}</td><td className={`mono ${signClass(q.changePct)}`}>{fmtPct(q.changePct)}</td></tr>)}</tbody></table>
          </div>
          <div className="card">
            <h3>Secteurs</h3>
            <table><tbody>{sectors.map((s) => <tr key={s.sector}><td className="left">{s.sector} <span className="muted">({s.count})</span></td><td className={`mono ${signClass(s.avgChangePct)}`}>{fmtPct(s.avgChangePct)}</td><td className="mono muted">{compact(s.value)}</td></tr>)}</tbody></table>
          </div>
        </div>
      </div>

      {recs.length > 0 && (
        <div>
          <div className="card-head"><h2>Idées du jour pour votre profil</h2></div>
          <div className="grid grid-3">{recs.map((r) => <RecommendationCard key={r.symbol} rec={r} />)}</div>
        </div>
      )}
      {status?.provider === "simulation" && (
        <p className="disclaimer">Le flux officiel BRVM est injoignable depuis ce serveur : les cours affichés sont simulés en temps réel à partir de l'historique de référence. Configurez DATA_PROVIDER=live sur un serveur ayant accès à brvm.org pour la cote officielle.</p>
      )}
    </div>
  );
}
