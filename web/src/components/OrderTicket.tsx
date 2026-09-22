import { useState } from "react";
import { post } from "../lib/api";
import { fmtFcfa, fmtNum } from "../lib/format";
import type { Order, OrderType, PortfolioSummary, Quote } from "../lib/types";

interface Props {
  quote: Quote;
  defaultQuantity?: number;
  suggestedTarget?: number;
  suggestedStop?: number;
  onFilled?: (summary: PortfolioSummary) => void;
}

const TYPE_LABEL: Record<OrderType, string> = {
  market: "Au marché (exécution immédiate)",
  limit: "À cours limité",
  stop: "Stop (déclenche un ordre au marché)",
  stop_limit: "Stop-limite",
};

/** Ticket d'ordre professionnel : marché, limite, stop, stop-limite, validité, ordres liés objectif + stop. */
export function OrderTicket({ quote, defaultQuantity, suggestedTarget, suggestedStop, onFilled }: Props) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<OrderType>("market");
  const [quantity, setQuantity] = useState(defaultQuantity ?? 10);
  const [limitPrice, setLimitPrice] = useState(quote.price);
  const [stopPrice, setStopPrice] = useState(quote.price);
  const [validity, setValidity] = useState<"day" | "gtc">("gtc");
  const [bracket, setBracket] = useState(false);
  const [takeProfit, setTakeProfit] = useState(suggestedTarget ?? Math.round(quote.price * 1.1));
  const [stopLoss, setStopLoss] = useState(suggestedStop ?? Math.round(quote.price * 0.93));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const px = type === "market" || type === "stop" ? quote.price : limitPrice;
  const gross = px * quantity;
  const fee = gross * 0.0125;
  const riskPerShare = bracket ? Math.max(0, px - stopLoss) : 0;
  const rewardPerShare = bracket ? Math.max(0, takeProfit - px) : 0;

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const body = {
        symbol: quote.symbol,
        side,
        type,
        quantity,
        validity,
        limitPrice: type === "limit" || type === "stop_limit" ? limitPrice : undefined,
        stopPrice: type === "stop" || type === "stop_limit" ? stopPrice : undefined,
        takeProfit: side === "buy" && bracket ? takeProfit : undefined,
        stopLoss: side === "buy" && bracket ? stopLoss : undefined,
      };
      const r = await post<{ order: Order; summary: PortfolioSummary }>("/portfolio/orders", body);
      const o = r.order;
      setMsg({
        ok: true,
        text:
          o.status === "filled"
            ? `Ordre exécuté à ${fmtNum(o.filled_price ?? 0)} FCFA${bracket && side === "buy" ? " · objectif et stop de protection posés" : ""}`
            : `Ordre ${TYPE_LABEL[o.type].toLowerCase()} enregistré, surveillé à chaque cotation`,
      });
      onFilled?.(r.summary);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Passer un ordre</h2>
        <div className="seg">
          <button className={side === "buy" ? "active up" : ""} onClick={() => setSide("buy")}>Achat</button>
          <button className={side === "sell" ? "active down" : ""} onClick={() => setSide("sell")}>Vente</button>
        </div>
      </div>
      <div className="field">
        <label>Type d'ordre</label>
        <select value={type} onChange={(e) => setType(e.target.value as OrderType)}>
          {(Object.keys(TYPE_LABEL) as OrderType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {(type === "stop" || type === "stop_limit") && (
          <div className="field">
            <label>Déclenchement (FCFA)</label>
            <input type="number" value={stopPrice} onChange={(e) => setStopPrice(Number(e.target.value))} />
          </div>
        )}
        {(type === "limit" || type === "stop_limit") && (
          <div className="field">
            <label>Prix limite (FCFA)</label>
            <input type="number" value={limitPrice} onChange={(e) => setLimitPrice(Number(e.target.value))} />
          </div>
        )}
        <div className="field">
          <label>Quantité</label>
          <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Math.max(1, Math.floor(Number(e.target.value))))} />
        </div>
        <div className="field">
          <label>Validité</label>
          <select value={validity} onChange={(e) => setValidity(e.target.value as "day" | "gtc")}>
            <option value="gtc">Jusqu'à annulation</option>
            <option value="day">Jour</option>
          </select>
        </div>
      </div>
      {side === "buy" && (
        <div className="field">
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={bracket} onChange={(e) => setBracket(e.target.checked)} style={{ width: "auto" }} />
            Ordres liés : objectif de cours + stop de protection (OCO)
          </label>
          {bracket && (
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 6 }}>
              <div><label>Objectif (vente limite)</label><input type="number" value={takeProfit} onChange={(e) => setTakeProfit(Number(e.target.value))} /></div>
              <div><label>Stop de protection</label><input type="number" value={stopLoss} onChange={(e) => setStopLoss(Number(e.target.value))} /></div>
              <p className="muted" style={{ gridColumn: "1 / -1", fontSize: 12, margin: 0 }}>
                Gain visé {fmtFcfa(rewardPerShare * quantity)} · risque {fmtFcfa(riskPerShare * quantity)} · ratio {riskPerShare ? (rewardPerShare / riskPerShare).toFixed(1) : "—"}
              </p>
            </div>
          )}
        </div>
      )}
      <ul className="clean" style={{ marginBottom: 10 }}>
        <li className="row"><span>Montant estimé</span><span className="spacer" /><span className="mono">{fmtFcfa(gross)}</span></li>
        <li className="row"><span>Frais estimés (1,25 %)</span><span className="spacer" /><span className="mono">{fmtFcfa(fee)}</span></li>
        <li className="row"><b>{side === "buy" ? "Total à payer" : "Net encaissé"}</b><span className="spacer" /><b className="mono">{fmtFcfa(side === "buy" ? gross + fee : gross - fee)}</b></li>
      </ul>
      <button className={`btn ${side}`} style={{ width: "100%" }} disabled={busy} onClick={submit}>
        {side === "buy" ? "Acheter" : "Vendre"} {quantity} {quote.symbol}
      </button>
      {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
      <p className="disclaimer">Portefeuille virtuel : les ordres sont simulés au cours affiché. Pour un ordre réel, transmettez-le à votre SGI.</p>
    </div>
  );
}
