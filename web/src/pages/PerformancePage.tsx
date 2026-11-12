import { useEffect, useState } from "react";
import { PerformanceChart } from "../components/PerformanceChart";
import { api, del, getToken } from "../lib/api";
import { fmtDate, fmtFcfa, fmtPct, signClass } from "../lib/format";
import type { Performance, TrackedPortfolio, TrackedView } from "../lib/types";

export function PerformancePage() {
  const [days, setDays] = useState(365);
  const [perf, setPerf] = useState<Performance | null>(null);
  const [tracked, setTracked] = useState<TrackedPortfolio[]>([]);
  const [open, setOpen] = useState<TrackedView | null>(null);
  const loadTracked = () => api<{ items: TrackedPortfolio[] }>("/tracking").then((r) => setTracked(r.items)).catch(() => {});
  useEffect(() => {
    api<Performance>(`/portfolio/performance?days=${days}`).then(setPerf).catch(() => {});
  }, [days]);
  useEffect(() => { loadTracked(); }, []);
  const openTracked = (id: number) => api<TrackedView>(`/tracking/${id}`).then(setOpen).catch(() => {});
  const removeTracked = async (id: number) => { await del(`/tracking/${id}`); if (open?.id === id) setOpen(null); loadTracked(); };
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
      <div className="card">
        <div className="card-head"><div><h2>Portefeuilles recommandés suivis</h2><span className="muted" style={{ fontSize: 12 }}>Chaque conseil ou cible « suivi » est figé à sa date (quantités au cours du jour, frais d'entrée déduits) puis valorisé chaque séance sur les cours ajustés des dividendes, net des frais de sortie, contre le BRVM Composite et le BRVM 30. C'est la mesure honnête de ce que valent les recommandations.</span></div></div>
        {tracked.length === 0 && <p className="muted">Aucun portefeuille suivi : utilisez « Suivre ce portefeuille » sur un rapport de conseil ou « Suivre cette cible » sur votre portefeuille détenu.</p>}
        {tracked.length > 0 && (
          <div className="table-scroll"><table>
            <thead><tr><th className="left">Portefeuille</th><th className="left">Depuis</th><th>Jours</th><th>Valeur nette</th><th>Perf. nette</th><th>BRVM Composite</th><th>BRVM 30</th><th>Écart / Composite</th><th>Perte max.</th><th>Séances gagnantes</th><th></th></tr></thead>
            <tbody>
              {tracked.map((t) => (
                <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => openTracked(t.id)}>
                  <td className="left"><b>{t.label}</b><br /><small className="muted">{t.kind} · {t.lines.length} lignes · {fmtFcfa(t.capital)}</small></td>
                  <td className="left mono">{fmtDate(t.startTs)}</td>
                  <td className="mono">{t.stats.days}</td>
                  <td className="mono">{fmtFcfa(t.stats.valueNet)}</td>
                  <td className={`mono ${signClass(t.stats.returnNetPct)}`}>{fmtPct(t.stats.returnNetPct, 2)}</td>
                  <td className={`mono ${signClass(t.stats.compositePct)}`}>{fmtPct(t.stats.compositePct, 2)}</td>
                  <td className={`mono ${signClass(t.stats.brvm30Pct)}`}>{fmtPct(t.stats.brvm30Pct, 2)}</td>
                  <td className={`mono ${signClass(t.stats.alphaCompositePct)}`}><b>{fmtPct(t.stats.alphaCompositePct, 2)}</b></td>
                  <td className="mono down">{t.stats.maxDrawdownPct} %</td>
                  <td className="mono">{t.stats.beatRate != null ? `${Math.round(t.stats.beatRate * 100)} %` : "—"}</td>
                  <td><button className="btn sm" onClick={(e) => { e.stopPropagation(); removeTracked(t.id); }}>Retirer</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {open && (
          <div style={{ marginTop: 12 }}>
            <h3>{open.label} · {open.lines.map((l) => `${l.symbol} ${l.weightPct} %`).join(" · ")}</h3>
            <PerformanceChart series={open.series} height={280} />
            <p className="muted" style={{ fontSize: 12 }}>Frais d'entrée {fmtFcfa(open.entryCost)} · liquidités conservées {fmtFcfa(open.cash)} · {open.stats.sessions} séance(s){open.stats.annualizedPct != null ? ` · ${fmtPct(open.stats.annualizedPct, 1)} annualisé` : ""}{open.stats.volatilityPct != null ? ` · volatilité ${open.stats.volatilityPct} %` : ""} · écart / BRVM 30 {fmtPct(open.stats.alphaBrvm30Pct, 2)}.</p>
          </div>
        )}
      </div>
      <p className="disclaimer">La valorisation est enregistrée chaque jour ; la courbe démarre au premier instantané disponible. L'indice est reconstitué à partir des clôtures avec la même pondération que l'indice temps réel de la plateforme.</p>
    </div>
  );
}
