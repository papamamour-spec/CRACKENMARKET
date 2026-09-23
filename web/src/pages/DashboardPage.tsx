import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { QuoteTable } from "../components/QuoteTable";
import { RecommendationCard } from "../components/RecommendationCard";
import { useMarket } from "../hooks/useMarket";
import { api } from "../lib/api";
import { compact, fmtFcfa, fmtNum, fmtPct, signClass } from "../lib/format";
import type { AdvisoryView, BehaviorProfile, Diagnostic, PortfolioSummary, Recommendation } from "../lib/types";
import { ADVISORY_STATUS_LABEL } from "../lib/types";
import { ScoreBar } from "../components/ScoreBar";
import { useAuth } from "../hooks/useAuth";
import { SkeletonCard } from "../components/Skeleton";

export function DashboardPage() {
  const { quotes, indices, status } = useMarket();
  const { user } = useAuth();
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [diag, setDiag] = useState<Diagnostic | null>(null);
  const [advisory, setAdvisory] = useState<AdvisoryView[]>([]);
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [profile, setProfile] = useState<BehaviorProfile | null>(null);
  const [sectors, setSectors] = useState<{ sector: string; count: number; avgChangePct: number; value: number }[]>([]);

  useEffect(() => {
    api<PortfolioSummary>("/portfolio").then(setSummary).catch(() => {});
    api<{ diagnostic: Diagnostic }>("/advisor/portfolio").then((r) => setDiag(r.diagnostic)).catch(() => {});
    api<AdvisoryView[]>("/advisory/requests").then((r) => setAdvisory(r.slice(0, 3))).catch(() => {});
    api<{ profile: BehaviorProfile; recommendations: Recommendation[] }>("/advisor/recommendations")
      .then((r) => {
        setProfile(r.profile);
        setRecs(r.recommendations.filter((x) => x.action === "ACHAT FORT" || x.action === "ACHAT").slice(0, 4));
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
      <div className="card row" style={{ background: "linear-gradient(90deg, var(--bg-2), var(--bg-3))" }}>
        <div>
          <h1>Bonjour {user?.fullName?.split(" ")[0] ?? ""}, voici vos conseils du jour</h1>
          <span className="muted">
            {profile ? <>Profil <b>{profile.style}</b> · discipline <b>{profile.disciplineScore}/100</b>{profile.biases.length > 0 && <span style={{ color: "var(--warn)" }}> · ⚠ {profile.biases.length} biais comportemental{profile.biases.length > 1 ? "aux" : ""} détecté{profile.biases.length > 1 ? "s" : ""}</span>}</> : "Analyse de votre profil en cours…"}
          </span>
        </div>
        <span className="spacer" />
        <Link to="/conseil" className="btn primary">{user?.role === "sgi" ? "Nouvelle demande de placement" : "Demander un conseil de placement"}</Link>
        <Link to="/conseiller" className="btn">Toutes mes recommandations</Link>
      </div>

      <div className="grid grid-3">
        <div className="card kpi">
          <span className="label">Mon portefeuille</span>
          <span className="value">{summary ? fmtFcfa(summary.totalValue) : "—"}</span>
          {summary && <span className={`sub ${signClass(summary.totalPnl)}`}>{fmtPct(summary.totalPnlPct)} depuis l'ouverture · <Link to="/performance">performance</Link></span>}
        </div>
        {diag && (
          <div className="card">
            <span className="label" style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>Santé du portefeuille</span>
            <div className="gauge" style={{ marginTop: 6 }}><span className="muted" style={{ width: 100, fontSize: 12 }}>Santé</span><ScoreBar value={diag.healthScore} positive /><span className="mono" style={{ width: 26 }}>{diag.healthScore}</span></div>
            <div className="gauge"><span className="muted" style={{ width: 100, fontSize: 12 }}>Diversification</span><ScoreBar value={diag.diversificationScore} positive /><span className="mono" style={{ width: 26 }}>{diag.diversificationScore}</span></div>
            <div className="gauge"><span className="muted" style={{ width: 100, fontSize: 12 }}>Risque</span><ScoreBar value={diag.riskScore} positive color={diag.riskScore > 65 ? "var(--down)" : "var(--warn)"} /><span className="mono" style={{ width: 26 }}>{diag.riskScore}</span></div>
            {diag.suggestions[0] && <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>{diag.suggestions[0]}</p>}
          </div>
        )}
        <div className="card">
          <span className="label" style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>{user?.role === "sgi" ? "Placements clients récents" : "Mes demandes de conseil"}</span>
          {advisory.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>Aucune demande. <Link to="/conseil">Décrivez un placement</Link> pour recevoir une allocation motivée et chiffrée.</p>
          ) : (
            <ul className="clean">{advisory.map((a) => <li key={a.id}><Link to="/conseil">{a.client_label ?? "Mon placement"} · {fmtFcfa(a.capital)}</Link> <span className={`badge ${a.status === "validated" ? "buy" : "hold"}`}>{ADVISORY_STATUS_LABEL[a.status]}</span></li>)}</ul>
          )}
        </div>
      </div>

      <div>
        <div className="card-head"><h2>Opportunités adaptées à votre profil</h2><Link to="/conseiller">Voir le détail et le diagnostic →</Link></div>
        {profile ? (
          <div className="grid grid-3">{recs.map((r) => <RecommendationCard key={r.symbol} rec={r} />)}</div>
        ) : (
          <div className="grid grid-3"><SkeletonCard lines={5} /><SkeletonCard lines={5} /><SkeletonCard lines={5} /></div>
        )}
      </div>

      <details className="card">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Marché du jour · BRVM Composite {indices[0] ? <span className={signClass(indices[0].changePct)}>{fmtNum(indices[0].value, 2)} ({fmtPct(indices[0].changePct)})</span> : null} · {compact(totalValue)} FCFA échangés · {upCount} ▲ / {downCount} ▼</summary>
        <div className="two-col" style={{ marginTop: 12 }}>
          <div>
            <div className="card-head"><h3>Valeurs les plus actives</h3><Link to="/marche">Toute la cote →</Link></div>
            <QuoteTable rows={active} compactMode />
          </div>
          <div className="grid">
            <div>
              <h3>Plus fortes hausses</h3>
              <table><tbody>{gainers.map((q) => <tr key={q.symbol}><td><Link to={`/valeur/${q.symbol}`} className="sym">{q.symbol}</Link></td><td className="mono">{fmtNum(q.price)}</td><td className={`mono ${signClass(q.changePct)}`}>{fmtPct(q.changePct)}</td></tr>)}</tbody></table>
            </div>
            <div>
              <h3>Plus fortes baisses</h3>
              <table><tbody>{losers.map((q) => <tr key={q.symbol}><td><Link to={`/valeur/${q.symbol}`} className="sym">{q.symbol}</Link></td><td className="mono">{fmtNum(q.price)}</td><td className={`mono ${signClass(q.changePct)}`}>{fmtPct(q.changePct)}</td></tr>)}</tbody></table>
            </div>
            <div>
              <h3>Secteurs</h3>
              <table><tbody>{sectors.map((s) => <tr key={s.sector}><td className="left">{s.sector} <span className="muted">({s.count})</span></td><td className={`mono ${signClass(s.avgChangePct)}`}>{fmtPct(s.avgChangePct)}</td><td className="mono muted">{compact(s.value)}</td></tr>)}</tbody></table>
            </div>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>{fmtNum(totalVolume)} titres échangés · {indices.map((i) => `${i.name} ${fmtNum(i.value, 2)}`).join(" · ")}</p>
      </details>
      {status?.provider === "simulation" && (
        <p className="disclaimer">Le flux officiel BRVM est injoignable depuis ce serveur : les cours affichés sont simulés en temps réel à partir de l'historique de référence. Configurez DATA_PROVIDER=live sur un serveur ayant accès à brvm.org pour la cote officielle.</p>
      )}
    </div>
  );
}
