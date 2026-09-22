import { useEffect, useState } from "react";
import { PerformanceChart } from "../components/PerformanceChart";
import { api, getToken } from "../lib/api";
import { fmtFcfa, fmtPct, signClass } from "../lib/format";
import type { Performance } from "../lib/types";

export function PerformancePage() {
  const [days, setDays] = useState(365);
  const [perf, setPerf] = useState<Performance | null>(null);
  useEffect(() => {
    api<Performance>(`/portfolio/performance?days=${days}`).then(setPerf).catch(() => {});
  }, [days]);
  if (!perf) return <div className="card">Calcul de la performance…</div>;
  const s = perf.stats;
  const alpha = s.totalReturnPct - s.benchmarkReturnPct;
  const exportCsv = async () => {
    const res = await fetch("/api/portfolio/trades.csv", { headers: { authorization: `Bearer ${getToken()}` } });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "crackenmarket-operations.csv";
    a.click();
  };
  return (
    <div className="grid">
      <div className="card row">
        <h1>Analyse de performance</h1>
        <div className="seg">{[30, 90, 180, 365, 1095].map((d) => <button key={d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>{d < 365 ? `${d} j` : `${Math.round(d / 365)} an${d > 365 ? "s" : ""}`}</button>)}</div>
        <span className="spacer" />
        <button className="btn" onClick={exportCsv}>Exporter les opérations (CSV)</button>
      </div>
      <div className="grid grid-3">
        <div className="card kpi"><span className="label">Performance totale</span><span className={`value ${signClass(s.totalReturnPct)}`}>{fmtPct(s.totalReturnPct)}</span><span className="sub muted">BRVM Composite sur la période : {fmtPct(s.benchmarkReturnPct)}</span></div>
        <div className="card kpi"><span className="label">Surperformance (alpha)</span><span className={`value ${signClass(alpha)}`}>{fmtPct(alpha)}</span><span className="sub muted">écart avec l'indice</span></div>
        <div className="card kpi"><span className="label">Ratio de Sharpe</span><span className="value">{s.sharpe}</span><span className="sub muted">volatilité annualisée {s.volatilityPct} %</span></div>
        <div className="card kpi"><span className="label">Perte maximale</span><span className="value down">{s.maxDrawdownPct} %</span><span className="sub muted">depuis un plus haut</span></div>
        <div className="card kpi"><span className="label">Taux de réussite</span><span className="value">{s.winRate} %</span><span className="sub muted">{s.trades} opération(s) · facteur de profit {s.profitFactor}</span></div>
        <div className="card kpi"><span className="label">Gain / perte moyens</span><span className="value"><span className="up">{fmtFcfa(s.avgWin)}</span> / <span className="down">{fmtFcfa(s.avgLoss)}</span></span><span className="sub muted">frais payés {fmtFcfa(s.feesPaid)}</span></div>
      </div>
      <div className="card"><h2>Portefeuille vs BRVM Composite</h2><PerformanceChart series={perf.series} height={360} /></div>
      <p className="disclaimer">La valorisation est enregistrée chaque jour ; la courbe démarre au premier instantané disponible. L'indice est reconstitué à partir des clôtures avec la même pondération que l'indice temps réel de la plateforme.</p>
    </div>
  );
}
