import { useEffect, useRef, useState } from "react";
import { createChart, ColorType, type UTCTimestamp } from "lightweight-charts";
import { useMarket } from "../hooks/useMarket";
import { api } from "../lib/api";
import { fmtFcfa, fmtNum, fmtPct, signClass } from "../lib/format";
import type { BacktestResult } from "../lib/types";

const STRATS = [
  { value: "sma_cross", label: "Croisement MM20 / MM50" },
  { value: "rsi_reversion", label: "Retour à la moyenne RSI (achat < 30, vente > 65)" },
  { value: "macd", label: "Croisement MACD" },
  { value: "buy_hold", label: "Acheter et conserver" },
];

export function BacktestPage() {
  const { quotes } = useMarket();
  const [symbol, setSymbol] = useState("SNTS");
  const [strategy, setStrategy] = useState("sma_cross");
  const [capital, setCapital] = useState(1_000_000);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const run = () => api<BacktestResult>(`/backtest/${symbol}?strategy=${strategy}&capital=${capital}`).then(setResult);
  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ref.current || !result) return;
    const chart = createChart(ref.current, {
      height: 320,
      layout: { background: { type: ColorType.Solid, color: "#101a2e" }, textColor: "#8b9bb8" },
      grid: { vertLines: { color: "#1a2740" }, horzLines: { color: "#1a2740" } },
      localization: { locale: "fr-FR", priceFormatter: (p: number) => fmtNum(p) },
      timeScale: { borderColor: "#223050" },
      rightPriceScale: { borderColor: "#223050" },
    });
    const s = chart.addAreaSeries({ lineColor: "#38bdf8", topColor: "rgba(56,189,248,.3)", bottomColor: "rgba(56,189,248,0)" });
    s.setData(result.equityCurve.map((p) => ({ time: (p.time / 1000) as UTCTimestamp, value: p.value })));
    s.setMarkers(result.signals.map((m) => ({ time: (m.time / 1000) as UTCTimestamp, position: m.side === "buy" ? "belowBar" : "aboveBar", color: m.side === "buy" ? "#22c55e" : "#ef4444", shape: m.side === "buy" ? "arrowUp" : "arrowDown", text: m.side === "buy" ? "Achat" : "Vente" })));
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current?.clientWidth ?? 600 }));
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [result]);

  return (
    <div className="grid">
      <div className="card row">
        <div style={{ width: 200 }}><label>Valeur</label><select value={symbol} onChange={(e) => setSymbol(e.target.value)}>{Array.from(quotes.keys()).sort().map((s) => <option key={s}>{s}</option>)}</select></div>
        <div style={{ width: 340 }}><label>Stratégie</label><select value={strategy} onChange={(e) => setStrategy(e.target.value)}>{STRATS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></div>
        <div style={{ width: 180 }}><label>Capital initial (FCFA)</label><input type="number" value={capital} onChange={(e) => setCapital(Number(e.target.value))} /></div>
        <button className="btn primary" onClick={run} style={{ alignSelf: "flex-end" }}>Lancer le backtest</button>
      </div>
      {result && (
        <>
          <div className="grid grid-3">
            <div className="card kpi"><span className="label">Capital final</span><span className="value">{fmtFcfa(result.finalEquity)}</span><span className={`sub ${signClass(result.totalReturnPct)}`}>{fmtPct(result.totalReturnPct, 1)}</span></div>
            <div className="card kpi"><span className="label">Acheter & conserver</span><span className={`value ${signClass(result.buyHoldReturnPct)}`}>{fmtPct(result.buyHoldReturnPct, 1)}</span><span className="sub muted">référence</span></div>
            <div className="card kpi"><span className="label">Transactions</span><span className="value">{result.trades}</span><span className="sub muted">taux de réussite {result.winRate} %</span></div>
            <div className="card kpi"><span className="label">Perte max. (drawdown)</span><span className="value down">{result.maxDrawdownPct} %</span><span className="sub muted">frais 1,25 % par ordre inclus</span></div>
          </div>
          <div className="card"><h2>Courbe de capital</h2><div ref={ref} /></div>
        </>
      )}
      <p className="disclaimer">Les performances passées ne préjugent pas des performances futures. Le backtest utilise l'historique quotidien disponible sur la plateforme (2 ans) et les frais de courtage moyens de la BRVM.</p>
    </div>
  );
}
