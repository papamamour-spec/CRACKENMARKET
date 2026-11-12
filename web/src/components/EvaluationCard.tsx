import { useEffect, useState } from "react";
import { api, post } from "../lib/api";
import { fmtDate, fmtDateTime, fmtPct } from "../lib/format";
import { HORIZON_LABEL, type EvaluationResponse, type HorizonEvaluation, type StrategyStats } from "../lib/types";

/** Courbe cumulée (base 100) des trois paniers, en SVG léger. */
function Curves({ s }: { s: HorizonEvaluation["strategy"] }) {
  const series: { label: string; color: string; st: StrategyStats }[] = [
    { label: "Top k", color: "var(--accent, #2563eb)", st: s.topK },
    { label: "Équipondéré", color: "var(--muted, #94a3b8)", st: s.equalWeight },
    ...(s.index ? [{ label: "Indice", color: "var(--warn, #f59e0b)", st: s.index }] : []),
  ];
  const all = series.flatMap((x) => x.st.curve.map((p) => p.value));
  if (!all.length) return null;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const W = 420;
  const H = 120;
  const x = (i: number, n: number) => (n > 1 ? (i / (n - 1)) * (W - 8) + 4 : 4);
  const y = (v: number) => H - 6 - ((v - min) / Math.max(1e-9, max - min)) * (H - 12);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Courbes cumulées de la stratégie, du panier équipondéré et de l'indice">
        <line x1={4} x2={W - 4} y1={y(100)} y2={y(100)} stroke="var(--border, #e2e8f0)" strokeDasharray="3 3" />
        {series.map((sr) => (
          <polyline key={sr.label} fill="none" stroke={sr.color} strokeWidth={sr.label === "Équipondéré" ? 1.5 : 2} points={sr.st.curve.map((p, i) => `${x(i, sr.st.curve.length)},${y(p.value)}`).join(" ")} />
        ))}
      </svg>
      <div className="row" style={{ gap: 12, fontSize: 11 }}>
        {series.map((sr) => <span key={sr.label}><i style={{ display: "inline-block", width: 14, height: 3, background: sr.color, verticalAlign: "middle", marginRight: 4 }} />{sr.label} {fmtPct(sr.st.totalReturnPct, 1)}</span>)}
      </div>
    </div>
  );
}

/**
 * Évaluation en marche avant du moteur de prévision : précision, corrélation de rang, calibration,
 * stratégie nette de frais. Chaque rapport est reproductible (même configuration, même graine).
 */
export function EvaluationCard({ analyst }: { analyst: boolean }) {
  const [data, setData] = useState<EvaluationResponse | null>(null);
  const [h, setH] = useState<string>("1M");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<EvaluationResponse>("/market/evaluation").then(setData).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const run = async () => {
    setBusy(true);
    try {
      const r = await post<{ started: boolean }>("/market/evaluation/run", {});
      setMsg(r.started ? "Évaluation lancée en tâche de fond (quelques minutes : chaque valeur est reprévue à chaque date sans regarder l'avenir)." : "Une évaluation est déjà en cours.");
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rep = data?.latest?.report ?? null;
  const cur = rep?.horizons.find((x) => x.horizon === h) ?? rep?.horizons[0] ?? null;
  const running = data?.status.running ?? null;
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Évaluation en marche avant</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            Backtest reproductible : à chaque date, chaque valeur est prévue avec son seul passé puis confrontée au rendement réalisé (série ajustée). Direction, erreur contre la prévision nulle, corrélation de rang (ce qui compte pour classer et optimiser), calibration de l'intervalle et de la probabilité, stratégie « k meilleures prévues » nette de frais de courtage contre l'indice et le panier équipondéré.
            {rep ? ` Dernier rapport ${fmtDateTime(rep.generatedAt)} · ${rep.universe} valeurs · du ${rep.firstDate ? fmtDate(rep.firstDate) : "—"} au ${rep.lastDate ? fmtDate(rep.lastDate) : "—"} · pas ${rep.config.step} séances · top ${rep.config.topK} · frais ${rep.config.feePct} % par ordre.` : " Aucun rapport encore calculé."}
            {running ? ` Calcul en cours : ${running.done} / ${running.total} dates.` : ""}
          </span>
        </div>
        <div className="row">
          {rep && <div className="seg">{rep.horizons.map((x) => <button key={x.horizon} className={h === x.horizon ? "active" : ""} onClick={() => setH(x.horizon)}>{HORIZON_LABEL[x.horizon]}</button>)}</div>}
          {analyst && <button className="btn sm" disabled={busy || !!running} onClick={run}>{running ? `En cours ${running.done}/${running.total}` : "Lancer une évaluation"}</button>}
        </div>
      </div>
      {msg && <p className="muted" style={{ fontSize: 12 }}>{msg}</p>}
      {rep && (
        <>
          <ul className="clean" style={{ fontSize: 12, marginBottom: 10 }}>{rep.verdict.map((v, i) => <li key={i}>• {v}</li>)}</ul>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th className="left">Horizon</th><th>Obs.</th><th>Direction</th><th>Référence</th><th>Erreur</th><th>Sans modèle</th><th>Gain</th><th>IC de rang</th><th>t</th><th>IC &gt; 0</th><th>Intervalle 90 %</th><th>Brier</th><th>Brier réf.</th></tr></thead>
              <tbody>
                {rep.horizons.map((x) => (
                  <tr key={x.horizon} className={x.horizon === h ? "sel" : ""} style={{ cursor: "pointer" }} onClick={() => setH(x.horizon)}>
                    <td className="left">{HORIZON_LABEL[x.horizon]}</td>
                    <td className="mono">{x.n}<span className="muted"> / {x.dates} dates</span></td>
                    <td className={`mono ${x.hitRate >= x.baselineHitRate ? "up" : "down"}`}>{Math.round(x.hitRate * 100)} %</td>
                    <td className="mono muted">{Math.round(x.baselineHitRate * 100)} %</td>
                    <td className={`mono ${x.skill >= 0 ? "up" : "down"}`}>{x.maePct} %</td>
                    <td className="mono muted">{x.naiveMaePct} %</td>
                    <td className={`mono ${x.skill >= 0 ? "up" : "down"}`}>{x.skill > 0 ? "+" : ""}{Math.round(x.skill * 100)} %</td>
                    <td className={`mono ${(x.ic.mean ?? 0) > 0 ? "up" : "down"}`}>{x.ic.mean != null ? x.ic.mean.toFixed(3) : "—"}</td>
                    <td className={`mono ${Math.abs(x.ic.tStat ?? 0) >= 2 ? "" : "muted"}`}>{x.ic.tStat != null ? x.ic.tStat.toFixed(1) : "—"}</td>
                    <td className="mono muted">{x.ic.positiveShare != null ? `${Math.round(x.ic.positiveShare * 100)} %` : "—"}</td>
                    <td className={`mono ${x.coverage90 >= 0.85 && x.coverage90 <= 0.95 ? "up" : "down"}`}>{Math.round(x.coverage90 * 100)} %</td>
                    <td className={`mono ${x.brier <= x.baselineBrier ? "up" : "down"}`}>{x.brier}</td>
                    <td className="mono muted">{x.baselineBrier}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cur && (
            <div className="grid grid-2" style={{ gap: 14, marginTop: 12 }}>
              <div style={{ minWidth: 0, overflowX: "auto" }}>
                <h4>Stratégie « {rep.config.topK} meilleures prévues » à {HORIZON_LABEL[cur.horizon]}, nette de frais</h4>
                <table>
                  <thead><tr><th className="left">Panier</th><th>Périodes</th><th>Total</th><th>Annualisé</th><th>Perte max.</th><th>Sharpe</th><th>Gagnantes</th></tr></thead>
                  <tbody>
                    {([["Top k (net de frais)", cur.strategy.topK], ["Équipondéré", cur.strategy.equalWeight], ...(cur.strategy.index ? [["Indice composite", cur.strategy.index] as [string, StrategyStats]] : [])] as [string, StrategyStats][]).map(([label, st]) => (
                      <tr key={label}>
                        <td className="left">{label}</td>
                        <td className="mono">{st.periods}</td>
                        <td className={`mono ${st.totalReturnPct >= 0 ? "up" : "down"}`}>{fmtPct(st.totalReturnPct, 1)}</td>
                        <td className="mono">{st.annualizedPct != null ? fmtPct(st.annualizedPct, 1) : "—"}</td>
                        <td className="mono down">−{st.maxDrawdownPct} %</td>
                        <td className="mono">{st.sharpe ?? "—"}</td>
                        <td className="mono">{Math.round(st.winShare * 100)} %</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted" style={{ fontSize: 11 }}>Frais cumulés de la stratégie : {cur.strategy.costsPct} % (seule la part du panier renouvelée paie l'aller-retour). Rebalancement toutes les {Math.max(1, Math.ceil(cur.horizonDays / rep.config.step)) * rep.config.step} séances, position tenue {cur.horizonDays} séances puis liquidités.</p>
                <Curves s={cur.strategy} />
              </div>
              <div style={{ minWidth: 0, overflowX: "auto" }}>
                <h4>Fiabilité de la probabilité de hausse ({HORIZON_LABEL[cur.horizon]})</h4>
                <table>
                  <thead><tr><th className="left">Annoncée</th><th>Obs.</th><th>Moyenne</th><th>Observée</th><th>Écart</th></tr></thead>
                  <tbody>
                    {cur.reliability.map((b) => (
                      <tr key={b.from}>
                        <td className="left mono">{Math.round(b.from * 100)} – {Math.round(b.to * 100)} %</td>
                        <td className="mono">{b.n}</td>
                        <td className="mono">{b.predicted != null ? `${Math.round(b.predicted * 100)} %` : "—"}</td>
                        <td className="mono">{b.observed != null ? `${Math.round(b.observed * 100)} %` : "—"}</td>
                        <td className={`mono ${b.predicted != null && b.observed != null ? (Math.abs(b.predicted - b.observed) <= 0.1 ? "up" : "down") : "muted"}`}>{b.predicted != null && b.observed != null ? fmtPct((b.observed - b.predicted) * 100, 0) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted" style={{ fontSize: 11 }}>Une probabilité est bien calibrée quand la fréquence observée rejoint la probabilité annoncée dans chaque tranche. L'intervalle à 90 % doit contenir le réalisé entre 85 et 95 % du temps ; le score de Brier (0 = parfait) est comparé à celui d'une probabilité constante égale à la fréquence de hausse.</p>
              </div>
            </div>
          )}
          <p className="disclaimer">Mesures passées, calculées sans regarder l'avenir, sur l'historique disponible ({rep.universe} valeurs). Elles servent à comparer les versions du modèle entre elles, pas à promettre un rendement. Sur des données simulées, elles ne décrivent pas le marché réel.</p>
        </>
      )}
    </div>
  );
}
