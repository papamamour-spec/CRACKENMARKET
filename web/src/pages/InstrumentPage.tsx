import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { OrderTicket } from "../components/OrderTicket";
import { OrderBookPanel } from "../components/OrderBookPanel";
import { NewsPanel } from "../components/NewsPanel";
import { PriceChart } from "../components/PriceChart";
import { RecommendationCard } from "../components/RecommendationCard";
import { ScoreBar } from "../components/ScoreBar";
import { PeriodChips, Range52 } from "../components/PeriodChips";
import { SkeletonCard } from "../components/Skeleton";
import { useQuote } from "../hooks/useMarket";
import { api, del, post } from "../lib/api";
import { compact, fmtNum, fmtPct, fmtTime, signClass } from "../lib/format";
import type { Recommendation, Technical } from "../lib/types";

export function InstrumentPage() {
  const { symbol = "" } = useParams();
  const quote = useQuote(symbol);
  const [tech, setTech] = useState<Technical | null>(null);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [ticks, setTicks] = useState<{ ts: number; price: number; volume: number }[]>([]);
  const [inWatch, setInWatch] = useState(false);

  const lastAnalysed = useRef(0);
  const load = () => {
    lastAnalysed.current = Date.now();
    api<Technical>(`/market/technical/${symbol}`).then(setTech).catch(() => {});
    api<Recommendation>(`/advisor/recommendations/${symbol}`).then(setRec).catch(() => {});
  };
  useEffect(() => {
    setTech(null);
    setRec(null);
    load();
    api<{ symbol: string }[]>("/watchlist").then((w) => setInWatch(w.some((x) => x.symbol === symbol))).catch(() => {});
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);
  // Analyse dynamique : recalcul après chaque cotation (au plus toutes les 5 s)
  useEffect(() => {
    if (!quote || Date.now() - lastAnalysed.current < 5000) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.price]);

  useEffect(() => {
    api<typeof ticks>(`/market/ticks/${symbol}?limit=30`).then(setTicks).catch(() => {});
  }, [symbol, quote?.ts]);

  if (!quote) return <SkeletonCard title={`Chargement de ${symbol}…`} lines={4} />;

  const toggleWatch = async () => {
    if (inWatch) await del(`/watchlist/${symbol}`);
    else await post(`/watchlist/${symbol}`, {});
    setInWatch(!inWatch);
  };

  return (
    <div className="grid">
      <div className="card row">
        <div>
          <h1>{quote.symbol} <span className="muted" style={{ fontWeight: 400 }}>{quote.name}</span></h1>
          <span className="muted">{quote.sector} · {quote.country} {quote.brvm30 && "· BRVM 30"}</span>
        </div>
        <div className="kpi"><span className="label">Dernier</span><span className="value">{fmtNum(quote.price)}</span><span className={`sub ${signClass(quote.change)}`}>{fmtNum(quote.change)} ({fmtPct(quote.changePct)})</span></div>
        <div className="kpi"><span className="label">Ouv. / Haut / Bas</span><span className="mono">{fmtNum(quote.open)} / {fmtNum(quote.high)} / {fmtNum(quote.low)}</span><span className="sub muted">Veille {fmtNum(quote.prevClose)}</span></div>
        <div className="kpi"><span className="label">Volume / Capitaux</span><span className="mono">{fmtNum(quote.volume)}</span><span className="sub muted">{compact(quote.value)} FCFA</span></div>
        <div className="kpi"><span className="label">Dernière cotation</span><span className="mono">{fmtTime(quote.ts)}</span><span className="sub muted">{quote.source === "live" ? "BRVM" : "simulation"}</span></div>
        <span className="spacer" />
        <button className="btn sm" onClick={toggleWatch}>{inWatch ? "★ Suivi" : "☆ Suivre"}</button>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Variations par période</h3>
          <span className="live-badge"><span className="dot on" /> recalculées à chaque cotation · analyse mise à jour {tech?.updatedAt ? fmtTime(tech.updatedAt) : "…"}</span>
        </div>
        <PeriodChips quote={quote} />
        <div style={{ marginTop: 10 }}><Range52 quote={quote} /></div>
      </div>

      <div className="two-col">
        <div className="grid">
          <div className="card"><PriceChart symbol={symbol} quote={quote} /></div>
          {!tech && <SkeletonCard title="Analyse technique" lines={5} />}
          {tech && (
            <div className="card">
              <div className="card-head"><h2>Analyse technique</h2><span className="live-badge"><span className="dot on" /> dynamique · {fmtTime(tech.updatedAt ?? Date.now())}</span></div>
              <div className="grid grid-3">
                {(["trend", "momentum", "meanReversion", "volume", "risk", "composite"] as const).map((k) => (
                  <div key={k} className="gauge">
                    <span className="muted" style={{ width: 110, fontSize: 12 }}>{{ trend: "Tendance", momentum: "Momentum", meanReversion: "Retour moyenne", volume: "Volumes", risk: "Sérénité", composite: "Score global" }[k]}</span>
                    <ScoreBar value={tech.scores[k] * 100} />
                    <span className="mono" style={{ width: 32, textAlign: "right" }}>{Math.round(tech.scores[k] * 100)}</span>
                  </div>
                ))}
              </div>
              <table style={{ marginTop: 12 }}>
                <tbody>
                  <tr><td className="left muted">MM20 / MM50 / MM200</td><td className="mono">{fmtNum(tech.sma20)} / {fmtNum(tech.sma50)} / {fmtNum(tech.sma200)}</td><td className="left muted">RSI 14</td><td className={`mono ${tech.rsi14 > 70 ? "down" : tech.rsi14 < 30 ? "up" : ""}`}>{tech.rsi14.toFixed(1)}</td></tr>
                  <tr><td className="left muted">MACD / Signal</td><td className="mono">{tech.macd.toFixed(1)} / {tech.macdSignal.toFixed(1)}</td><td className="left muted">Stochastique %K</td><td className="mono">{tech.stochK.toFixed(0)}</td></tr>
                  <tr><td className="left muted">Bollinger haut / bas</td><td className="mono">{fmtNum(tech.bollUpper)} / {fmtNum(tech.bollLower)}</td><td className="left muted">ATR 14</td><td className="mono">{fmtNum(tech.atr14)}</td></tr>
                  <tr><td className="left muted">Support / Résistance 60j</td><td className="mono">{fmtNum(tech.support)} / {fmtNum(tech.resistance)}</td><td className="left muted">Volumes 5j / 60j</td><td className="mono">×{tech.volumeRatio.toFixed(2)}</td></tr>
                  <tr><td className="left muted">Volatilité 60j</td><td className="mono">{(tech.volatility60 * 100).toFixed(1)} %</td><td className="left muted">Drawdown max 1 an</td><td className="mono down">{(tech.maxDrawdown250 * 100).toFixed(1)} %</td></tr>
                  <tr><td className="left muted">Perf 1s / 1m / 3m</td><td className="mono">{fmtPct(tech.perf1w, 1)} / {fmtPct(tech.perf1m, 1)} / {fmtPct(tech.perf3m, 1)}</td><td className="left muted">Perf 6m / 1 an · Sharpe</td><td className="mono">{fmtPct(tech.perf6m, 1)} / {fmtPct(tech.perf1y, 1)} · {tech.sharpe250.toFixed(2)}</td></tr>
                </tbody>
              </table>
              {tech.signals.length > 0 && <ul className="clean" style={{ marginTop: 8 }}>{tech.signals.map((s, i) => <li key={i}>• {s}</li>)}</ul>}
            </div>
          )}
        </div>
        <div className="grid">
          {rec && <RecommendationCard rec={rec} detailed />}
          <NewsPanel symbol={symbol} limit={8} title={`Actualité ${symbol}`} />
          <details className="card">
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Négocier cette valeur (carnet d'ordres, ticket, transactions)</summary>
            <p className="muted" style={{ fontSize: 12 }}>Réservé aux investisseurs qui souhaitent passer eux-mêmes leurs ordres. Le conseil ci-dessus reste la référence ; l'exécution réelle passe par votre SGI.</p>
            <div className="grid" style={{ marginTop: 8 }}>
              <OrderBookPanel symbol={symbol} />
              <OrderTicket quote={quote} defaultQuantity={rec?.suggestedQuantity || 10} suggestedTarget={rec?.targetPrice} suggestedStop={rec?.stopLoss} />
              <div className="card">
                <h3>Dernières transactions</h3>
                <table>
                  <tbody>
                    {ticks.map((t, i) => (
                      <tr key={i}><td className="left mono muted">{fmtTime(t.ts)}</td><td className="mono">{fmtNum(t.price)}</td><td className="mono muted">{fmtNum(t.volume)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
