import { useState } from "react";
import { post } from "../lib/api";
import { fmtFcfa, fmtNum } from "../lib/format";
import type { Order, PortfolioSummary, Quote } from "../lib/types";

interface Props {
  quote: Quote;
  defaultQuantity?: number;
  onFilled?: (summary: PortfolioSummary) => void;
}

export function OrderTicket({ quote, defaultQuantity, onFilled }: Props) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [quantity, setQuantity] = useState(defaultQuantity ?? 10);
  const [limitPrice, setLimitPrice] = useState(quote.price);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const px = type === "market" ? quote.price : limitPrice;
  const gross = px * quantity;
  const fee = gross * 0.0125;

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<{ order: Order; summary: PortfolioSummary }>("/portfolio/orders", { symbol: quote.symbol, side, type, quantity, limitPrice: type === "limit" ? limitPrice : undefined });
      setMsg({ ok: true, text: r.order.status === "filled" ? `Ordre exécuté à ${fmtNum(r.order.filled_price ?? 0)} FCFA` : "Ordre limite enregistré, en attente d'exécution" });
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
        <select value={type} onChange={(e) => setType(e.target.value as "market" | "limit")}>
          <option value="market">Au marché (exécution immédiate)</option>
          <option value="limit">À cours limité</option>
        </select>
      </div>
      {type === "limit" && (
        <div className="field">
          <label>Prix limite (FCFA)</label>
          <input type="number" value={limitPrice} onChange={(e) => setLimitPrice(Number(e.target.value))} />
        </div>
      )}
      <div className="field">
        <label>Quantité</label>
        <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Math.max(1, Math.floor(Number(e.target.value))))} />
      </div>
      <ul className="clean" style={{ marginBottom: 10 }}>
        <li className="row"><span>Montant brut</span><span className="spacer" /><span className="mono">{fmtFcfa(gross)}</span></li>
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
