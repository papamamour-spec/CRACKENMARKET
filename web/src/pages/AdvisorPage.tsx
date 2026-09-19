import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RecommendationCard } from "../components/RecommendationCard";
import { ActionBadge, ScoreBar } from "../components/ScoreBar";
import { api } from "../lib/api";
import { fmtFcfa, fmtNum, fmtPct, signClass } from "../lib/format";
import type { Allocation, BehaviorProfile, Diagnostic, Recommendation } from "../lib/types";

export function AdvisorPage() {
  const [data, setData] = useState<{ profile: BehaviorProfile; recommendations: Recommendation[] } | null>(null);
  const [diag, setDiag] = useState<{ diagnostic: Diagnostic; allocation: Allocation[] } | null>(null);
  const [filter, setFilter] = useState<"all" | "buy" | "held">("buy");
  const [error, setError] = useState("");

  useEffect(() => {
    const load = () => {
      api<typeof data>("/advisor/recommendations").then(setData).catch((e) => setError(e.message));
      api<typeof diag>("/advisor/portfolio").then(setDiag).catch(() => {});
    };
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="card error">{error}</div>;
  if (!data) return <div className="card">Analyse du marché et de votre comportement en cours…</div>;
  const { profile, recommendations } = data;
  const list = recommendations.filter((r) => (filter === "all" ? true : filter === "buy" ? r.action.startsWith("ACHAT") : r.held));

  return (
    <div className="grid">
      <div className="grid grid-3">
        <div className="card">
          <h3>Votre profil effectif</h3>
          <div className="kpi"><span className="value">{profile.style}</span><span className="sub muted">Tolérance au risque {profile.effectiveRiskTolerance.toFixed(1)}/5 (déclarée {profile.declared.riskTolerance}/5) · horizon {profile.declared.horizonMonths} mois</span></div>
          <div style={{ marginTop: 10 }}>
            <div className="gauge"><span className="muted" style={{ width: 90, fontSize: 12 }}>Discipline</span><ScoreBar value={profile.disciplineScore} positive /><span className="mono" style={{ width: 30 }}>{profile.disciplineScore}</span></div>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>{profile.tradesPerMonth.toFixed(1)} ordres/mois · taux de réussite {Math.round(profile.winRate * 100)} % · détention moyenne {Math.round(profile.avgHoldingDays)} j · P&L réalisé {fmtFcfa(profile.totalRealizedPnl)}</p>
          <Link to="/profil" style={{ fontSize: 12 }}>Modifier mon questionnaire →</Link>
        </div>
        <div className="card">
          <h3>Biais comportementaux détectés</h3>
          {profile.biases.length === 0 && <p className="up">Aucun biais détecté : continuez ainsi.</p>}
          {profile.biases.map((b) => (
            <div key={b.code} className="bias">
              <b>{b.title} <span className="muted" style={{ fontWeight: 400 }}>(sévérité {Math.round(b.severity * 100)} %)</span></b>
              <p>{b.description}</p>
              <p className="advice">→ {b.advice}</p>
            </div>
          ))}
        </div>
        {diag && (
          <div className="card">
            <h3>Santé du portefeuille</h3>
            <div className="gauge"><span className="muted" style={{ width: 110, fontSize: 12 }}>Santé globale</span><ScoreBar value={diag.diagnostic.healthScore} positive /><span className="mono" style={{ width: 30 }}>{diag.diagnostic.healthScore}</span></div>
            <div className="gauge"><span className="muted" style={{ width: 110, fontSize: 12 }}>Diversification</span><ScoreBar value={diag.diagnostic.diversificationScore} positive /><span className="mono" style={{ width: 30 }}>{diag.diagnostic.diversificationScore}</span></div>
            <div className="gauge"><span className="muted" style={{ width: 110, fontSize: 12 }}>Risque</span><ScoreBar value={diag.diagnostic.riskScore} positive color={diag.diagnostic.riskScore > 65 ? "var(--down)" : "var(--warn)"} /><span className="mono" style={{ width: 30 }}>{diag.diagnostic.riskScore}</span></div>
            <ul className="clean" style={{ marginTop: 8 }}>{diag.diagnostic.suggestions.map((s, i) => <li key={i}>• {s}</li>)}</ul>
            {diag.diagnostic.rebalancing.length > 0 && (
              <table style={{ marginTop: 8 }}>
                <tbody>{diag.diagnostic.rebalancing.map((r, i) => <tr key={i}><td className="left"><Link to={`/valeur/${r.symbol}`} className="sym">{r.symbol}</Link></td><td className="left"><span className={`badge ${r.action === "vendre" ? "sell" : r.action === "alléger" ? "reduce" : r.action === "renforcer" ? "buy" : "strong-buy"}`}>{r.action}</span></td><td className="left muted" style={{ whiteSpace: "normal", fontSize: 12 }}>{r.reason}</td></tr>)}</tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {diag && diag.allocation.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Allocation proposée</h2><span className="muted" style={{ fontSize: 12 }}>Construite sur vos meilleures adéquations, max. 3 valeurs par secteur, réserve de liquidités adaptée au profil</span></div>
          <table>
            <thead><tr><th className="left">Valeur</th><th>Poids</th><th>Quantité</th><th>Montant</th></tr></thead>
            <tbody>{diag.allocation.map((a) => <tr key={a.symbol}><td><Link to={`/valeur/${a.symbol}`} className="sym">{a.symbol}<small>{a.name}</small></Link></td><td className="mono">{a.weightPct} %</td><td className="mono">{a.quantity}</td><td className="mono">{fmtFcfa(a.amount)}</td></tr>)}</tbody>
          </table>
        </div>
      )}

      <div>
        <div className="card-head">
          <h2>Recommandations personnalisées ({list.length})</h2>
          <div className="seg">
            <button className={filter === "buy" ? "active" : ""} onClick={() => setFilter("buy")}>Opportunités d'achat</button>
            <button className={filter === "held" ? "active" : ""} onClick={() => setFilter("held")}>Mes positions</button>
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>Toute la cote</button>
          </div>
        </div>
        {filter === "all" ? (
          <div className="card">
            <table>
              <thead><tr><th className="left">Valeur</th><th className="left">Conseil</th><th>Score</th><th>Adéquation</th><th>Cours</th><th>Objectif</th><th>Stop</th><th>Potentiel</th><th>Confiance</th></tr></thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.symbol}>
                    <td><Link to={`/valeur/${r.symbol}`} className="sym">{r.symbol}<small>{r.name}</small></Link></td>
                    <td className="left"><ActionBadge action={r.action} /></td>
                    <td className={`mono ${signClass(r.score)}`}>{r.score}</td>
                    <td className="mono">{r.fitScore}</td>
                    <td className="mono">{fmtNum(r.price)}</td>
                    <td className="mono up">{fmtNum(r.targetPrice)}</td>
                    <td className="mono down">{fmtNum(r.stopLoss)}</td>
                    <td className={`mono ${signClass(r.expectedReturnPct)}`}>{fmtPct(r.expectedReturnPct, 1)}</td>
                    <td className="mono">{Math.round(r.confidence * 100)} %</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid grid-3">{list.map((r) => <RecommendationCard key={r.symbol} rec={r} />)}</div>
        )}
      </div>
      <p className="disclaimer">Le moteur Kraken combine l'analyse technique de l'historique de marché (tendance, momentum, retour à la moyenne, volumes, risque), le rendement des dividendes et votre profil comportemental observé. Les recommandations sont recalculées à chaque cotation. Elles constituent une aide à la décision, pas un conseil en investissement au sens de la réglementation AMF-UMOA.</p>
    </div>
  );
}
