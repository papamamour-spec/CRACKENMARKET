import { Link } from "react-router-dom";
import { fmtDateTime, fmtFcfa, fmtNum, fmtPct, signClass } from "../lib/format";
import { ADVISORY_STATUS_LABEL, type AdvisoryReport, type AdvisoryView } from "../lib/types";
import { ScoreBar } from "./ScoreBar";

/** Frontière efficiente : volatilité (x) / rendement attendu (y), le portefeuille retenu en surbrillance. */
function Frontier({ o }: { o: NonNullable<AdvisoryReport["optimization"]> }) {
  const pts = o.frontier;
  const xs = [...pts.map((p) => p.volatilityPct), o.volatilityPct];
  const ys = [...pts.map((p) => p.expectedReturnPct), o.expectedAnnualReturnPct, o.riskFreePct];
  const x0 = 0;
  const x1 = Math.max(...xs) * 1.15 || 1;
  const y0 = Math.min(...ys) - 1;
  const y1 = Math.max(...ys) + 1;
  const W = 320;
  const H = 170;
  const px = (v: number) => 36 + ((v - x0) / (x1 - x0)) * (W - 46);
  const py = (v: number) => H - 22 - ((v - y0) / (y1 - y0)) * (H - 32);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${px(p.volatilityPct).toFixed(1)},${py(p.expectedReturnPct).toFixed(1)}`).join(" ");
  return (
    <div>
      <h4 style={{ margin: "0 0 4px" }}>Frontière efficiente</h4>
      <svg viewBox={`0 0 ${W} ${H}`} className="frontier" role="img" aria-label="Frontière efficiente">
        <line x1={36} y1={H - 22} x2={W - 8} y2={H - 22} className="axis" />
        <line x1={36} y1={8} x2={36} y2={H - 22} className="axis" />
        <text x={(W + 36) / 2} y={H - 1} textAnchor="middle" className="lbl">volatilité annuelle (%)</text>
        <text x={10} y={H / 2} className="lbl" transform={`rotate(-90 10 ${H / 2})`} textAnchor="middle">rendement (%)</text>
        {[0, 0.5, 1].map((t) => <text key={t} x={30} y={py(y0 + (y1 - y0) * t) + 3} textAnchor="end" className="lbl">{(y0 + (y1 - y0) * t).toFixed(0)}</text>)}
        {[0.5, 1].map((t) => <text key={t} x={px(x0 + (x1 - x0) * t)} y={H - 10} textAnchor="middle" className="lbl">{(x0 + (x1 - x0) * t).toFixed(0)}</text>)}
        <circle cx={px(0)} cy={py(o.riskFreePct)} r={3} className="rf" /><text x={px(0) + 6} y={py(o.riskFreePct) - 4} className="lbl">sans risque</text>
        <path d={path} className="curve" />
        {pts.map((p, i) => <circle key={i} cx={px(p.volatilityPct)} cy={py(p.expectedReturnPct)} r={2.5} className="pt" />)}
        <circle cx={px(o.volatilityPct)} cy={py(o.expectedAnnualReturnPct)} r={5} className="chosen" />
        <text x={px(o.volatilityPct) + (px(o.volatilityPct) > W * 0.6 ? -8 : 8)} y={py(o.expectedAnnualReturnPct) + 4} textAnchor={px(o.volatilityPct) > W * 0.6 ? "end" : "start"} className="lbl strong">portefeuille proposé</text>
      </svg>
      <p className="muted" style={{ fontSize: 11, margin: 0 }}>Chaque point est le portefeuille le moins volatil pour un rendement donné, sous vos contraintes ; au-dessus de la courbe, rien n'est atteignable.</p>
    </div>
  );
}

const OBJECTIVE = { income: "Revenus réguliers", growth: "Croissance du capital", balanced: "Équilibré", speculative: "Plus-values rapides" } as Record<string, string>;

/** Rapport de conseil en investissement : synthèse, allocation, scénarios, diagnostic de l'existant, avis de l'analyste. */
export function AdvisoryReportView({ v, compact = false }: { v: AdvisoryView; compact?: boolean }) {
  const r = v.report;
  const badge = v.status === "validated" ? "buy" : v.status === "declined" ? "sell" : "hold";
  return (
    <div className="report">
      <div className="row" style={{ marginBottom: 8 }}>
        <span className={`badge ${badge}`}>{ADVISORY_STATUS_LABEL[v.status]}</span>
        <span className="muted" style={{ fontSize: 12 }}>
          Demande n° {v.id} · {v.requester_type === "sgi" ? `SGI ${v.sgi_code} · client ${v.client_label}` : "particulier"} · {fmtDateTime(v.created_at)} · rapport {fmtDateTime(r.generatedAt)}
        </span>
      </div>
      <div className="grid grid-3">
        <div className="kpi"><span className="label">Capital à placer</span><span className="value">{fmtFcfa(v.capital)}</span><span className="sub muted">{OBJECTIVE[v.objective]} · {v.horizon_months} mois · risque {v.risk_tolerance}/5 · profil {r.style}</span></div>
        <div className="kpi"><span className="label">Rendement de dividende attendu</span><span className="value up">{r.metrics.expectedDividendYieldPct} %</span><span className="sub muted">≈ {fmtFcfa(r.metrics.annualDividendIncome)} par an</span></div>
        <div className="kpi"><span className="label">Performance visée sur l'horizon</span><span className={`value ${signClass(r.metrics.expectedReturnPct)}`}>{fmtPct(r.metrics.expectedReturnPct, 1)}</span><span className="sub muted">{fmtPct(r.metrics.annualizedReturnPct, 1)} annualisé · volatilité ≈ {r.metrics.estimatedVolatilityPct} %</span></div>
      </div>
      <ul className="clean" style={{ margin: "12px 0" }}>{r.summary.map((s, i) => <li key={i}>• {s}</li>)}</ul>
      {r.warnings.length > 0 && <ul className="clean" style={{ marginBottom: 12 }}>{r.warnings.map((w, i) => <li key={i} style={{ color: "var(--warn)" }}>⚠ {w}</li>)}</ul>}
      {v.analyst_note && (
        <div className="bias" style={{ borderLeftColor: v.status === "validated" ? "var(--up)" : "var(--down)" }}>
          <b>Avis de l'analyste {v.reviewed_at && <span className="muted" style={{ fontWeight: 400 }}>· {fmtDateTime(v.reviewed_at)}</span>}</b>
          <p>{v.analyst_note}</p>
        </div>
      )}
      <h3>Allocation proposée · {r.metrics.lines} valeurs · {fmtFcfa(r.investable)} investis, {fmtFcfa(r.cashReserve)} de réserve ({r.cashReservePct} %)</h3>
      <table>
        <thead><tr><th className="left">Valeur</th><th className="left">Secteur</th><th>Poids</th><th>Quantité</th><th>Cours</th><th>Montant</th><th>Rdt div.</th><th>Perf. visée</th><th>Adéquation</th>{!compact && <th className="left">Justification</th>}</tr></thead>
        <tbody>
          {r.allocation.map((l) => (
            <tr key={l.symbol}>
              <td><Link to={`/valeur/${l.symbol}`} className="sym">{l.symbol}<small>{l.name}</small></Link></td>
              <td className="left muted">{l.sector}</td>
              <td className="mono">{l.weightPct} %</td>
              <td className="mono">{l.quantity}</td>
              <td className="mono">{fmtNum(l.price)}</td>
              <td className="mono">{fmtNum(l.amount)}</td>
              <td className="mono">{l.dividendYield.toFixed(1)} %</td>
              <td className={`mono ${signClass(l.expectedReturnPct)}`}>{fmtPct(l.expectedReturnPct, 1)}</td>
              <td style={{ minWidth: 90 }}><div className="gauge"><ScoreBar value={l.fitScore} positive /><span className="mono" style={{ width: 26 }}>{l.fitScore}</span></div></td>
              {!compact && <td className="left muted" style={{ whiteSpace: "normal", fontSize: 12, maxWidth: 320 }}>{l.rationale.join(" · ")}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid grid-3" style={{ marginTop: 14 }}>
        <div>
          <h3>Répartition sectorielle</h3>
          <table><tbody>{r.sectorBreakdown.map((s) => <tr key={s.sector}><td className="left">{s.sector}</td><td className="mono">{s.weightPct} %</td></tr>)}</tbody></table>
        </div>
        <div>
          <h3>Scénarios à {r.scenarios.horizonMonths} mois</h3>
          <table><tbody>
            <tr><td className="left down">Défavorable</td><td className="mono">{fmtFcfa(r.scenarios.pessimistic)}</td></tr>
            <tr><td className="left">Central</td><td className="mono"><b>{fmtFcfa(r.scenarios.central)}</b></td></tr>
            <tr><td className="left up">Favorable</td><td className="mono">{fmtFcfa(r.scenarios.optimistic)}</td></tr>
          </tbody></table>
          <p className="muted" style={{ fontSize: 11 }}>Bornes ± une volatilité estimée sur l'horizon, dividendes inclus.</p>
        </div>
        {r.existing && (
          <div>
            <h3>Portefeuille existant</h3>
            <div className="gauge"><span className="muted" style={{ width: 100, fontSize: 12 }}>Santé</span><ScoreBar value={r.existing.diagnostic.healthScore} positive /><span className="mono" style={{ width: 26 }}>{r.existing.diagnostic.healthScore}</span></div>
            <div className="gauge"><span className="muted" style={{ width: 100, fontSize: 12 }}>Diversification</span><ScoreBar value={r.existing.diagnostic.diversificationScore} positive /><span className="mono" style={{ width: 26 }}>{r.existing.diagnostic.diversificationScore}</span></div>
            <ul className="clean" style={{ marginTop: 6 }}>{r.existing.actions.map((a, i) => <li key={i}><span className={`badge ${a.action === "vendre" ? "sell" : a.action === "alléger" ? "reduce" : "buy"}`}>{a.action}</span> {a.symbol} · <span className="muted">{a.reason}</span></li>)}</ul>
          </div>
        )}
      </div>
      {r.optimization && (
        <div style={{ marginTop: 14 }}>
          <h3>Optimisation du portefeuille · {r.optimization.method === "optimizer" ? "moyenne-variance sous contraintes" : "heuristique par score"}</h3>
          <div className="grid grid-2" style={{ gap: 14 }}>
            <div>
              <div className="grid grid-3" style={{ gap: 10 }}>
                <div className="kpi"><span className="label">Rendement annuel attendu</span><span className={`value ${signClass(r.optimization.expectedAnnualReturnPct)}`}>{fmtPct(r.optimization.expectedAnnualReturnPct, 1)}</span><span className="sub muted">dont dividendes {r.optimization.dividendYieldPct} %</span></div>
                <div className="kpi"><span className="label">Volatilité annuelle</span><span className="value">{r.optimization.volatilityPct} %</span><span className="sub muted">minimum possible {r.optimization.minVolatilityPct} %</span></div>
                <div className="kpi"><span className="label">Ratio de Sharpe</span><span className="value">{r.optimization.sharpe.toFixed(2)}</span><span className="sub muted">taux sans risque {r.optimization.riskFreePct} %</span></div>
              </div>
              {r.optimization.targetYieldPct != null && (
                <p className={r.optimization.reachedTarget ? "success" : "error"} style={{ marginTop: 10 }}>
                  {r.optimization.reachedTarget ? `Objectif de ${r.optimization.targetYieldPct} % par an atteint.` : `Objectif de ${r.optimization.targetYieldPct} % par an hors de portée : maximum ${r.optimization.maxAchievablePct} % sous vos contraintes.`}
                </p>
              )}
              <p className="muted" style={{ fontSize: 12 }}>Contraintes : {r.optimization.constraints.maxLines} lignes max., {r.optimization.constraints.maxWeightPct} % max. par valeur, {r.optimization.constraints.maxSectorWeightPct} % max. par secteur, {r.optimization.constraints.investedMaxPct} % investis au plus{r.optimization.constraints.excludedSectors.length ? `, secteurs exclus : ${r.optimization.constraints.excludedSectors.join(", ")}` : ""}.</p>
              {r.optimization.notes.map((n, i) => <p key={i} className="muted" style={{ fontSize: 12 }}>{n}</p>)}
            </div>
            {r.optimization.frontier.length > 0 && <Frontier o={r.optimization} />}
          </div>
        </div>
      )}
      {r.forecasts && r.forecasts.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3>Prévisions à 3 mois des valeurs retenues</h3>
          <table>
            <thead><tr><th className="left">Valeur</th><th>Attendu</th><th>P(hausse)</th><th>Intervalle 90 %</th><th>Précision</th>{!compact && <th className="left">Explication</th>}</tr></thead>
            <tbody>
              {r.forecasts.map((f) => (
                <tr key={f.symbol}>
                  <td><Link to={`/valeur/${f.symbol}`} className="sym">{f.symbol}</Link></td>
                  <td className={`mono ${signClass(f.expectedReturn3MPct)}`}>{fmtPct(f.expectedReturn3MPct, 1)}</td>
                  <td className="mono">{Math.round(f.probUp3M * 100)} %</td>
                  <td className="mono muted">{fmtPct(f.p5, 1)} … {fmtPct(f.p95, 1)}</td>
                  <td className="mono">{Math.round(f.hitRate3M * 100)} %</td>
                  {!compact && <td className="left muted" style={{ whiteSpace: "normal", fontSize: 12, maxWidth: 420 }}>{f.explanation}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {r.newsContext && r.newsContext.marketCount > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3>Actualité prise en compte · sentiment de place {r.newsContext.marketSentiment > 0 ? "+" : ""}{r.newsContext.marketSentiment} sur {r.newsContext.marketCount} article{r.newsContext.marketCount > 1 ? "s" : ""}</h3>
          <ul className="clean">{r.newsContext.headlines.map((h, i) => <li key={i}><span className={h.sentiment >= 0.2 ? "up" : h.sentiment <= -0.2 ? "down" : "muted"}>●</span> <a href={h.url} target="_blank" rel="noreferrer">{h.title}</a> <span className="muted" style={{ fontSize: 11 }}>{h.source} · {fmtDateTime(h.published_at)}</span></li>)}</ul>
        </div>
      )}
      <p className="disclaimer">Proposition produite par le moteur Kraken à partir de l'historique de marché et du profil déclaré{v.status === "validated" ? ", validée par un analyste de CrackenMarket" : ""}. Elle constitue une aide à la décision et ne remplace pas un conseil personnalisé au sens de la réglementation AMF-UMOA ; les ordres sont exécutés par une SGI agréée.</p>
    </div>
  );
}
