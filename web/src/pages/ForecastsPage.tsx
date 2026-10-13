import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { fmtDateTime, fmtNum, fmtPct, signClass } from "../lib/format";
import { HORIZON_LABEL, type ForecastRanking, type Horizon } from "../lib/types";
import { SkeletonCard } from "../components/Skeleton";

/** Classement des valeurs par rendement attendu (pondéré par la confiance), avec précision mesurée. */
export function ForecastsPage() {
  const [h, setH] = useState<Horizon>("1M");
  const [data, setData] = useState<ForecastRanking | null>(null);
  const [sector, setSector] = useState("all");
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
            <div className="kpi"><span className="label">Précision directionnelle moyenne</span><span className="value">{Math.round(avgHit * 100)} %</span><span className="sub muted">référence sans modèle {Math.round(avgBase * 100)} % · <span className={avgHit > avgBase ? "up" : "down"}>{avgHit > avgBase ? "+" : ""}{Math.round((avgHit - avgBase) * 100)} pt</span></span></div>
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
        </>
      )}
    </div>
  );
}
