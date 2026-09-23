import { Link } from "react-router-dom";
import { fmtDateTime, fmtFcfa, fmtNum, fmtPct, signClass } from "../lib/format";
import { ADVISORY_STATUS_LABEL, type AdvisoryView } from "../lib/types";
import { ScoreBar } from "./ScoreBar";

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
