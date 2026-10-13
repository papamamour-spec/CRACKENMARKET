import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { fmtDateTime, fmtNum, fmtPct, signClass } from "../lib/format";
import { HORIZON_LABEL, type Forecast, type ForecastLogRow, type Horizon, type HorizonForecast } from "../lib/types";
import { SkeletonCard } from "./Skeleton";

/** Barre de probabilité : part de hausse en vert, de baisse en rouge. */
function ProbBar({ p }: { p: number }) {
  return (
    <div className="probbar" title={`Probabilité de hausse ${Math.round(p * 100)} %`}>
      <span style={{ width: `${Math.round(p * 100)}%` }} />
    </div>
  );
}

/** Intervalle à 90 % : p5 → p95 avec la médiane, sur une échelle commune. */
function Interval({ h, scale }: { h: HorizonForecast; scale: number }) {
  const x = (v: number) => 50 + (v / scale) * 50;
  return (
    <svg viewBox="0 0 100 10" className="interval" preserveAspectRatio="none">
      <line x1={50} y1={0} x2={50} y2={10} className="zero" />
      <rect x={x(h.quantiles.p5)} y={3} width={Math.max(0.5, x(h.quantiles.p95) - x(h.quantiles.p5))} height={4} className="band" />
      <rect x={x(h.quantiles.p25)} y={2} width={Math.max(0.5, x(h.quantiles.p75) - x(h.quantiles.p25))} height={6} className="core" />
      <line x1={x(h.quantiles.p50)} y1={0} x2={x(h.quantiles.p50)} y2={10} className="median" />
    </svg>
  );
}

/** Apprentissage continu : précision en conditions réelles, réglages appris, dernières prévisions résolues. */
function LearningBlock({ h, journal }: { h: HorizonForecast; journal: ForecastLogRow[] }) {
  const L = h.learning;
  const resolved = journal.filter((j) => j.resolved_at != null).slice(0, 8);
  const pending = journal.filter((j) => j.resolved_at == null).length;
  return (
    <div className="learn">
      <div className="card-head" style={{ marginBottom: 6 }}>
        <div><h4 style={{ margin: 0 }}>Apprentissage continu · {HORIZON_LABEL[h.horizon]}</h4><span className="muted" style={{ fontSize: 12 }}>Chaque prévision est journalisée puis confrontée au cours constaté ; le modèle se recalibre à chaque résolution (version {L.version}{L.updatedAt ? `, ${fmtDateTime(L.updatedAt)}` : ""}).</span></div>
        <span className="badge hold">{L.resolved} résolue{L.resolved > 1 ? "s" : ""}{pending ? ` · ${pending} en attente` : ""}</span>
      </div>
      {L.resolved === 0 ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>Aucune prévision encore résolue pour cet horizon : la précision réelle s'affichera dès que les premières échéances seront atteintes.</p>
      ) : (
        <div className="grid grid-3" style={{ gap: 10 }}>
          <div className="kpi"><span className="label">Direction correcte (réel)</span><span className="value">{Math.round((L.liveHitRate ?? 0) * 100)} %</span><span className="sub muted">backtest {Math.round(h.accuracy.hitRate * 100)} % · Brier {L.brier}</span></div>
          <div className="kpi"><span className="label">Erreur moyenne (réel)</span><span className="value">{L.liveMaePct} %</span><span className="sub muted">intervalle 90 % tenu {Math.round((L.coverage90 ?? 0) * 100)} % du temps</span></div>
          <div className="kpi"><span className="label">Réglages appris</span><span className="value" style={{ fontSize: 14 }}>λ {L.lambda} · vol ×{L.volScale}</span><span className="sub muted">biais {fmtPct(L.biasPct, 1)} · actualité {L.newsFactor} · erreurs ridge {L.modelErr.ridge?.toFixed(1) ?? "—"} / AR {L.modelErr.ar?.toFixed(1) ?? "—"}</span></div>
        </div>
      )}
      {resolved.length > 0 && (
        <table style={{ marginTop: 8 }}>
          <thead><tr><th className="left">Émise le</th><th>Cours</th><th>Prévu</th><th>Constaté</th><th>Direction</th><th>Intervalle</th><th className="left">Origine</th></tr></thead>
          <tbody>
            {resolved.map((j) => (
              <tr key={j.id}>
                <td className="left mono muted">{j.made_day}</td>
                <td className="mono">{fmtNum(j.price)}</td>
                <td className={`mono ${signClass(j.expected_pct)}`}>{fmtPct(j.expected_pct, 1)}</td>
                <td className={`mono ${signClass(j.realized_pct ?? 0)}`}>{fmtPct(j.realized_pct ?? 0, 1)}</td>
                <td className={j.hit ? "up" : "down"}>{j.hit ? "✓" : "✗"}</td>
                <td className={j.covered ? "muted" : "down"}>{j.covered ? "tenu" : "dépassé"}</td>
                <td className="left muted" style={{ fontSize: 11 }}>{j.source === "backfill" ? "amorçage (rejouée)" : "en direct"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Prévision probabiliste d'une valeur : trois horizons, précision mesurée, facteurs explicatifs. */
export function ForecastCard({ symbol }: { symbol: string }) {
  const [f, setF] = useState<Forecast | null>(null);
  const [h, setH] = useState<Horizon>("1M");
  const [err, setErr] = useState<string | null>(null);
  const [journal, setJournal] = useState<ForecastLogRow[]>([]);
  useEffect(() => {
    setF(null);
    api<Forecast>(`/market/forecast/${symbol}`).then(setF).catch((e) => setErr((e as Error).message));
    api<ForecastLogRow[]>(`/market/forecasts/journal/${symbol}?limit=40`).then(setJournal).catch(() => setJournal([]));
  }, [symbol]);
  if (err) return <div className="card"><h3>Prévision</h3><p className="muted">{err}</p></div>;
  if (!f) return <SkeletonCard lines={6} />;
  const cur = f.horizons.find((x) => x.horizon === h)!;
  const scale = Math.max(5, ...f.horizons.map((x) => Math.max(Math.abs(x.quantiles.p5), Math.abs(x.quantiles.p95)))) * 1.1;
  const contribs = [...cur.contributions].filter((c) => c.factor !== "base").sort((a, b) => Math.abs(b.contributionPct) - Math.abs(a.contributionPct)).slice(0, 6);
  const maxC = Math.max(0.1, ...contribs.map((c) => Math.abs(c.contributionPct)));
  const skill = cur.accuracy.hitRate - cur.accuracy.baselineHitRate;
  return (
    <div className="card">
      <div className="card-head">
        <div><h3 style={{ margin: 0 }}>Prévision Kraken</h3><span className="muted" style={{ fontSize: 12 }}>Modèle d'ensemble (régression ridge + autorégressif + Monte-Carlo) · volatilité {f.dailyVolPct} % ann. · {fmtDateTime(f.generatedAt)}</span></div>
        <div className="seg">{f.horizons.map((x) => <button key={x.horizon} className={h === x.horizon ? "active" : ""} onClick={() => setH(x.horizon)}>{HORIZON_LABEL[x.horizon]}</button>)}</div>
      </div>
      <div className="grid grid-3" style={{ gap: 10 }}>
        <div className="kpi"><span className="label">Rendement attendu</span><span className={`value ${signClass(cur.expectedReturnPct)}`}>{fmtPct(cur.expectedReturnPct, 1)}</span><span className="sub muted">cible médiane {fmtNum(cur.priceTargets.p50)} FCFA</span></div>
        <div className="kpi"><span className="label">Probabilité de hausse</span><span className="value">{Math.round(cur.probUp * 100)} %</span><ProbBar p={cur.probUp} /><span className="sub muted">&gt; +5 % : {Math.round(cur.probAbove5 * 100)} % · &lt; −5 % : {Math.round(cur.probBelow5 * 100)} %</span></div>
        <div className="kpi"><span className="label">Précision historique</span><span className="value">{Math.round(cur.accuracy.hitRate * 100)} %</span><span className="sub muted">{cur.accuracy.samples} fenêtres de test · référence {Math.round(cur.accuracy.baselineHitRate * 100)} % <span className={skill > 0 ? "up" : "down"}>({skill > 0 ? "+" : ""}{Math.round(skill * 100)} pt)</span> · confiance {Math.round(cur.confidence * 100)} %</span></div>
      </div>
      <table style={{ marginTop: 10 }}>
        <thead><tr><th className="left">Horizon</th><th>Attendu</th><th>P(hausse)</th><th className="left" style={{ width: "40%" }}>Intervalle 90 % (p5 · p25–p75 · p95)</th><th>Cours p5 / p95</th></tr></thead>
        <tbody>
          {f.horizons.map((x) => (
            <tr key={x.horizon} className={x.horizon === h ? "sel" : ""} style={{ cursor: "pointer" }} onClick={() => setH(x.horizon)}>
              <td className="left">{HORIZON_LABEL[x.horizon]}</td>
              <td className={`mono ${signClass(x.expectedReturnPct)}`}>{fmtPct(x.expectedReturnPct, 1)}</td>
              <td className="mono">{Math.round(x.probUp * 100)} %</td>
              <td className="left"><Interval h={x} scale={scale} /><span className="muted mono" style={{ fontSize: 11 }}>{fmtPct(x.quantiles.p5, 1)} … {fmtPct(x.quantiles.p95, 1)}</span></td>
              <td className="mono muted">{fmtNum(x.priceTargets.p5)} / {fmtNum(x.priceTargets.p95)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid grid-2" style={{ marginTop: 12, gap: 12 }}>
        <div>
          <h4>Pourquoi cette prévision ({HORIZON_LABEL[h]})</h4>
          <ul className="clean" style={{ fontSize: 13 }}>{cur.explanations.map((e, i) => <li key={i}>• {e}</li>)}</ul>
          <p className="muted" style={{ fontSize: 11, margin: "6px 0 0" }}>Ensemble : régression {fmtPct(cur.models.ridgePct, 1)} (poids {Math.round(cur.models.weights.ridge * 100)} %) · AR {fmtPct(cur.models.arPct, 1)} (poids {Math.round(cur.models.weights.ar * 100)} %){cur.models.newsAdjustmentPct !== 0 ? ` · actualité ${fmtPct(cur.models.newsAdjustmentPct, 1)}` : ""} · erreur moyenne {cur.accuracy.maePct} % (sans modèle {cur.accuracy.naiveMaePct} %).</p>
        </div>
        <div>
          <h4>Contribution des facteurs (points de %)</h4>
          {contribs.map((c) => (
            <div key={c.factor} className="contrib">
              <span className="muted" title={c.label}>{c.label}</span>
              <div className="contrib-bar"><span className={c.contributionPct >= 0 ? "pos" : "neg"} style={{ width: `${(Math.abs(c.contributionPct) / maxC) * 50}%`, [c.contributionPct >= 0 ? "left" : "right"]: "50%" } as React.CSSProperties} /></div>
              <span className={`mono ${signClass(c.contributionPct)}`}>{fmtPct(c.contributionPct, 1)}</span>
            </div>
          ))}
        </div>
      </div>
      <LearningBlock h={cur} journal={journal.filter((j) => j.horizon === h)} />
      <p className="disclaimer">Prévision probabiliste issue de l'historique de la valeur ; la précision affichée est mesurée sur des fenêtres passées (30 % des observations, jamais vues à l'apprentissage) et ne garantit pas les résultats futurs.</p>
    </div>
  );
}
