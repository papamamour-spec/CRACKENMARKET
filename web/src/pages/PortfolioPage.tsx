import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMarket } from "../hooks/useMarket";
import { api, del } from "../lib/api";
import { fmtDateTime, fmtFcfa, fmtNum, fmtPct, signClass } from "../lib/format";
import type { Order, PortfolioSummary } from "../lib/types";

export function PortfolioPage() {
  const { quotes } = useMarket();
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);

  const load = () => {
    api<PortfolioSummary>("/portfolio").then(setSummary).catch(() => {});
    api<Order[]>("/portfolio/orders").then(setOrders).catch(() => {});
  };
  useEffect(load, []);

  // Recalcul en temps réel de la valorisation à partir des cotations WebSocket
  const positions = (summary?.positions ?? []).map((p) => {
    const q = quotes.get(p.symbol);
    const price = q?.price ?? p.currentPrice;
    const mv = price * p.quantity;
    return { ...p, currentPrice: price, marketValue: mv, unrealizedPnl: mv - p.costBasis, unrealizedPnlPct: p.costBasis ? ((mv - p.costBasis) / p.costBasis) * 100 : 0, dayChangePct: q?.changePct ?? p.dayChangePct };
  });
  const invested = positions.reduce((a, p) => a + p.marketValue, 0);
  const cash = summary?.portfolio.cash ?? 0;
  const total = cash + invested;
  const initial = summary?.portfolio.initialCash ?? 0;

  const cancel = async (id: number) => {
    await del(`/portfolio/orders/${id}`);
    load();
  };

  return (
    <div className="grid">
      <div className="grid grid-3">
        <div className="card kpi"><span className="label">Valorisation totale</span><span className="value">{fmtFcfa(total)}</span><span className={`sub ${signClass(total - initial)}`}>{fmtFcfa(total - initial)} ({fmtPct(initial ? ((total - initial) / initial) * 100 : 0)})</span></div>
        <div className="card kpi"><span className="label">Investi</span><span className="value">{fmtFcfa(invested)}</span><span className={`sub ${signClass(invested - positions.reduce((a, p) => a + p.costBasis, 0))}`}>Latent {fmtFcfa(positions.reduce((a, p) => a + p.unrealizedPnl, 0))}</span></div>
        <div className="card kpi"><span className="label">Liquidités</span><span className="value">{fmtFcfa(cash)}</span><span className="sub muted">{total ? Math.round((cash / total) * 100) : 0} % du portefeuille</span></div>
        <div className="card kpi"><span className="label">P&L réalisé</span><span className={`value ${signClass(summary?.realizedPnl ?? 0)}`}>{fmtFcfa(summary?.realizedPnl ?? 0)}</span><span className="sub muted">{positions.length} ligne(s)</span></div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Positions</h2><span><Link to="/performance">Analyse de performance</Link> · <Link to="/conseiller">Diagnostic du conseiller →</Link></span></div>
        {positions.length === 0 ? (
          <p className="muted">Aucune position. Consultez le <Link to="/conseiller">conseiller</Link> pour vos premières idées.</p>
        ) : (
          <table>
            <thead><tr><th className="left">Valeur</th><th>Qté</th><th>PRU</th><th>Cours</th><th>Var. jour</th><th>Valorisation</th><th>+/- value</th><th>%</th><th>Poids</th></tr></thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.symbol}>
                  <td><Link to={`/valeur/${p.symbol}`} className="sym">{p.symbol}<small>{p.name}</small></Link></td>
                  <td className="mono">{p.quantity}</td>
                  <td className="mono">{fmtNum(p.avgPrice)}</td>
                  <td className="mono">{fmtNum(p.currentPrice)}</td>
                  <td className={`mono ${signClass(p.dayChangePct)}`}>{fmtPct(p.dayChangePct)}</td>
                  <td className="mono">{fmtNum(p.marketValue)}</td>
                  <td className={`mono ${signClass(p.unrealizedPnl)}`}>{fmtNum(p.unrealizedPnl)}</td>
                  <td className={`mono ${signClass(p.unrealizedPnl)}`}>{fmtPct(p.unrealizedPnlPct)}</td>
                  <td className="mono">{invested ? ((p.marketValue / invested) * 100).toFixed(1) : 0} %</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Ordres</h2>
        <table>
          <thead><tr><th className="left">Date</th><th className="left">Valeur</th><th className="left">Sens</th><th className="left">Type</th><th>Qté</th><th>Limite</th><th>Exécuté</th><th className="left">Statut</th><th></th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="left mono muted">{fmtDateTime(o.created_at)}</td>
                <td className="left sym">{o.symbol}</td>
                <td className={`left ${o.side === "buy" ? "up" : "down"}`}>{o.side === "buy" ? "Achat" : "Vente"}</td>
                <td className="left muted">{{ market: "Marché", limit: "Limite", stop: "Stop", stop_limit: "Stop-limite" }[o.type]}{o.oco_group ? " · OCO" : ""}{o.validity === "day" ? " · jour" : ""}</td>
                <td className="mono">{o.quantity}</td>
                <td className="mono">{o.stop_price ? `▸ ${fmtNum(o.stop_price)} ` : ""}{o.limit_price ? fmtNum(o.limit_price) : o.stop_price ? "" : "—"}</td>
                <td className="mono">{o.filled_price ? fmtNum(o.filled_price) : "—"}</td>
                <td className="left">{{ filled: "Exécuté", open: o.triggered_at ? "Déclenché" : "En attente", cancelled: "Annulé", rejected: "Rejeté", expired: "Expiré" }[o.status] ?? o.status}</td>
                <td>{o.status === "open" && <button className="btn sm" onClick={() => cancel(o.id)}>Annuler</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
