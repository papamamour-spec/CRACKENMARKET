import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, post } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { fmtDateTime, fmtNum, fmtPct, signClass } from "../lib/format";
import { HORIZON_LABEL, type ForecastRanking, type Horizon, type LearningSummary } from "../lib/types";
import { SkeletonCard } from "../components/Skeleton";

/** Classement des valeurs par rendement attendu (pondéré par la confiance), avec précision mesurée. */
export function ForecastsPage() {
  const [h, setH] = useState<Horizon>("1M");
  const [data, setData] = useState<ForecastRanking | null>(null);
  const [sector, setSector] = useState("all");
  const [learning, setLearning] = useState<LearningSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const { user } = useAuth();
  const analyst = user?.role === "analyst" || user?.role === "admin";
  const loadLearning = () => api<LearningSummary>("/market/forecasts/learning").then(setLearning).catch(() => {});
  useEffect(() => {
    loadLearning();
    const t = setInterval(loadLearning, 15000);
    return () => clearInterval(t);
  }, []);
  const learnNow = async () => {
    setBusy(true);
    try { await post("/market/forecasts/learn", {}); await loadLearning(); } finally { setBusy(false); }
  };
  useEffect(() => {
    let alive = true;
    const load = () => api<ForecastRanking>(`/market/forecasts?horizon=${h}`).then((d) => alive && setData(d)).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [h]);
  const sectors = data ? Array.from(new Set(data.items.map((i) => i.sector))).sort() : [];
  const items = (data?.items ?? []).filter((i) => sector === "all" || i.sector === sector);
  const avgHit = items.length ? items.reduce((a, i) => a + i.horizons[h].hitRate, 0) / items.length : 0;
  const avgBase = items.length ? items.reduce((a, i) => a + i.horizons[h].baselineHitRate, 0) / items.length : 0;
  const up = items.filter((i) => i.horizons[h].expectedReturnPct > 0).length;
  const live = learning?.byHorizon.find((x) => x.horizon === h) ?? null;
  const months = learning ? Array.from(new Set(learning.monthly.map((m) => m.month))).slice(-12) : [];
  return (
    <div className="grid">
      <div className="card row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Prévisions de fluctuations</h1>
          <span className="muted">Pour chaque valeur, un modèle d'ensemble entraîné sur son historique estime le rendement attendu, la probabilité de hausse et un intervalle à 90 %, avec une précision mesurée sur le passé.</span>
        </div>
        <div className="row">
          <div className="seg">{(["1W", "1M", "3M"] as Horizon[]).map((x) => <button key={x} className={h === x ? "active" : ""} onClick={() => setH(x)}>{HORIZON_LABEL[x]}</button>)}</div>
          <select value={sector} onChange={(e) => setSector(e.target.value)} style={{ width: 180 }}><option value="all">Tous secteurs</option>{sectors.map((s) => <option key={s}>{s}</option>)}</select>
        </div>
      </div>
      {!data && <SkeletonCard lines={8} />}
      {data && (
        <>
          <div className="card grid grid-3">
            <div className="kpi"><span className="label">Valeurs prévues</span><span className="value">{data.ready} / {data.total}</span><span className="sub muted">{data.ready < data.total ? "calcul en cours en tâche de fond…" : `dernière mise à jour ${fmtDateTime(Math.max(...data.items.map((i) => i.generatedAt)))}`}</span></div>
            <div className="kpi"><span className="label">Biais du marché à {HORIZON_LABEL[h]}</span><span className="value">{items.length ? Math.round((up / items.length) * 100) : 0} % haussier</span><span className="sub muted">{up} valeurs attendues en hausse sur {items.length}</span></div>
            <div className="kpi"><span className="label">Précision en backtest</span><span className="value">{Math.round(avgHit * 100)} %</span><span className="sub muted">référence sans modèle {Math.round(avgBase * 100)} % · <span className={avgHit > avgBase ? "up" : "down"}>{avgHit > avgBase ? "+" : ""}{Math.round((avgHit - avgBase) * 100)} pt</span></span></div>
            <div className="kpi"><span className="label">Précision en conditions réelles</span><span className="value">{live && live.hitRate != null ? `${Math.round(live.hitRate * 100)} %` : "—"}</span><span className="sub muted">{live && live.resolved ? <>{live.resolved} prévisions résolues · référence {Math.round((live.naiveHitRate ?? 0) * 100)} % · erreur {live.maePct} % (sans modèle {live.naiveMaePct} %) · intervalle tenu {Math.round((live.coverage90 ?? 0) * 100)} %</> : learning?.backfill && !learning.backfill.done ? "amorçage en cours…" : "en attente des premières échéances"}</span></div>
          </div>
          <div className="card">
            <table>
              <thead><tr><th className="left">#</th><th className="left">Valeur</th><th className="left">Secteur</th><th>Cours</th><th>Attendu</th><th>P(hausse)</th><th>Intervalle 90 %</th><th>Précision</th><th>Confiance</th><th className="left">Explication principale</th></tr></thead>
              <tbody>
                {items.map((i, k) => {
                  const x = i.horizons[h];
                  return (
                    <tr key={i.symbol}>
                      <td className="left muted mono">{k + 1}</td>
                      <td><Link to={`/valeur/${i.symbol}`} className="sym">{i.symbol}<small>{i.name}</small></Link></td>
                      <td className="left muted">{i.sector}</td>
                      <td className="mono">{fmtNum(i.price)}</td>
                      <td className={`mono ${signClass(x.expectedReturnPct)}`}><b>{fmtPct(x.expectedReturnPct, 1)}</b></td>
                      <td><div className="probbar sm" title={`${Math.round(x.probUp * 100)} %`}><span style={{ width: `${Math.round(x.probUp * 100)}%` }} /></div><span className="mono muted" style={{ fontSize: 11 }}>{Math.round(x.probUp * 100)} %</span></td>
                      <td className="mono muted" style={{ fontSize: 12 }}>{fmtPct(x.p5, 1)} … {fmtPct(x.p95, 1)}</td>
                      <td className="mono">{Math.round(x.hitRate * 100)} % <span className={`muted ${x.hitRate > x.baselineHitRate ? "up" : "down"}`} style={{ fontSize: 11 }}>({x.hitRate > x.baselineHitRate ? "+" : ""}{Math.round((x.hitRate - x.baselineHitRate) * 100)})</span></td>
                      <td className="mono">{Math.round(x.confidence * 100)} %</td>
                      <td className="left muted" style={{ whiteSpace: "normal", fontSize: 12, maxWidth: 360 }}>{i.topExplanation}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="disclaimer">Classement par rendement attendu × confiance. Les prévisions sont probabilistes : l'intervalle à 90 % indique la fourchette dans laquelle le rendement devrait se situer 9 fois sur 10 d'après la volatilité récente ; la précision est le taux de bonne direction mesuré sur des fenêtres passées non vues à l'apprentissage.</p>
          </div>
          {learning && (
            <div className="card">
              <div className="card-head">
                <div><h2>Apprentissage continu</h2><span className="muted" style={{ fontSize: 12 }}>Chaque prévision émise est journalisée, puis confrontée au cours constaté à l'échéance. À chaque résolution, le modèle de la valeur se recalibre : pondération des modèles, biais, largeur des intervalles, poids de l'actualité ; la régularisation est rechoisie par validation. {learning.totalResolved} prévisions résolues, {learning.totalPending} en attente{learning.lastCycleAt ? ` · dernier cycle ${fmtDateTime(learning.lastCycleAt)}` : ""}{learning.nextCycleAt ? ` · prochain ${fmtDateTime(learning.nextCycleAt)}` : ""}{learning.backfill && !learning.backfill.done ? " · amorçage en cours (prévisions rejouées sur l'historique)" : ""}.</span></div>
                {analyst && <button className="btn sm" disabled={busy} onClick={learnNow}>Lancer un cycle maintenant</button>}
              </div>
              <div className="grid grid-2" style={{ gap: 14 }}>
                <div style={{ minWidth: 0, overflowX: "auto" }}>
                  <h4>Précision réelle par horizon</h4>
                  <table>
                    <thead><tr><th className="left">Horizon</th><th>Résolues</th><th>Direction</th><th>Référence</th><th>Erreur</th><th>Sans modèle</th><th>Intervalle 90 %</th><th>Brier</th></tr></thead>
                    <tbody>
                      {learning.byHorizon.map((x) => (
                        <tr key={x.horizon}>
                          <td className="left">{HORIZON_LABEL[x.horizon]}</td>
                          <td className="mono">{x.resolved}{x.pending ? <span className="muted"> (+{x.pending})</span> : null}</td>
                          <td className={`mono ${x.hitRate != null && x.naiveHitRate != null ? (x.hitRate >= x.naiveHitRate ? "up" : "down") : ""}`}>{x.hitRate != null ? `${Math.round(x.hitRate * 100)} %` : "—"}</td>
                          <td className="mono muted">{x.naiveHitRate != null ? `${Math.round(x.naiveHitRate * 100)} %` : "—"}</td>
                          <td className={`mono ${x.maePct != null && x.naiveMaePct != null ? (x.maePct <= x.naiveMaePct ? "up" : "down") : ""}`}>{x.maePct != null ? `${x.maePct} %` : "—"}</td>
                          <td className="mono muted">{x.naiveMaePct != null ? `${x.naiveMaePct} %` : "—"}</td>
                          <td className="mono">{x.coverage90 != null ? `${Math.round(x.coverage90 * 100)} %` : "—"}</td>
                          <td className="mono">{x.brier ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {months.length > 0 && (
                    <>
                      <h4 style={{ marginTop: 10 }}>Évolution mensuelle de la direction correcte ({HORIZON_LABEL[h]})</h4>
                      <div className="months">
                        {months.map((m) => {
                          const row = learning.monthly.find((x) => x.month === m && x.horizon === h);
                          const v = row ? row.hitRate : null;
                          return <div key={m} className="month" title={row ? `${m} : ${Math.round(row.hitRate * 100)} % sur ${row.resolved} prévisions, erreur ${row.maePct} %` : m}><div className="bar"><span style={{ height: `${v != null ? Math.round(v * 100) : 0}%` }} className={v != null && v >= 0.5 ? "pos" : "neg"} /></div><span className="muted">{m.slice(2).replace("-", "/")}</span><span className="mono">{v != null ? `${Math.round(v * 100)}` : "—"}</span></div>;
                        })}
                      </div>
                    </>
                  )}
                </div>
                <div style={{ minWidth: 0, overflowX: "auto" }}>
                  <h4>Derniers recalibrages</h4>
                  <table>
                    <thead><tr><th className="left">Valeur</th><th>Horizon</th><th>Version</th><th>Résolues</th><th>λ</th><th>Vol ×</th><th>Biais</th><th>Actualité</th></tr></thead>
                    <tbody>
                      {learning.recentAdjustments.map((a) => (
                        <tr key={`${a.symbol}${a.horizon}`}>
                          <td><Link to={`/valeur/${a.symbol}`} className="sym">{a.symbol}</Link></td>
                          <td className="mono muted">{a.horizon}</td>
                          <td className="mono">{a.version}</td>
                          <td className="mono">{a.resolved}</td>
                          <td className="mono">{a.lambda}</td>
                          <td className="mono">{a.volScale}</td>
                          <td className={`mono ${signClass(a.biasPct)}`}>{fmtPct(a.biasPct, 1)}</td>
                          <td className="mono">{a.newsFactor}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="muted" style={{ fontSize: 11 }}>λ : régularisation choisie par validation en marche avant. Vol × : facteur appliqué à la largeur des intervalles pour viser une couverture de 90 %. Biais : correction apprise des écarts systématiques. Actualité : poids du sentiment, renforcé seulement s'il réduit l'erreur.</p>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
