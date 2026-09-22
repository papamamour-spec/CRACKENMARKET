import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, post } from "../lib/api";
import { fmtFcfa, fmtNum } from "../lib/format";
import { SGI_STATUS_LABEL, type Order, type OrderType, type PortfolioSummary, type Quote, type SgiAccount, type SgiOrder, type SgiPartner } from "../lib/types";

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
  // mode réel : compte-titres validé chez une SGI partenaire
  const [mode, setMode] = useState<"virtual" | "real">("virtual");
  const [sgiAccount, setSgiAccount] = useState<SgiAccount | null>(null);
  const [sgiPartner, setSgiPartner] = useState<SgiPartner | null>(null);
  const [sgiValidity, setSgiValidity] = useState<"day" | "week" | "gtc">("day");
  useEffect(() => {
    Promise.all([api<SgiAccount[]>("/sgi/accounts"), api<SgiPartner[]>("/sgi/partners")])
      .then(([accounts, partners]) => {
        const verified = accounts.find((a) => a.status === "verified");
        setSgiAccount(verified ?? null);
        setSgiPartner(partners.find((p) => p.code === verified?.sgi_code) ?? partners[0] ?? null);
      })
      .catch(() => {});
  }, []);
  const real = mode === "real";
  const effectiveType: OrderType = real && (type === "stop" || type === "stop_limit") ? "market" : type;

  const px = effectiveType === "market" ? quote.price : limitPrice;
  const gross = px * quantity;
  const fee = real && sgiPartner ? Math.max(sgiPartner.minFee, gross * (sgiPartner.brokerageFeePct / 100)) + gross * (sgiPartner.marketFeePct / 100) : gross * 0.0125;
  const riskPerShare = bracket ? Math.max(0, px - stopLoss) : 0;
  const rewardPerShare = bracket ? Math.max(0, takeProfit - px) : 0;

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (real && sgiAccount) {
        const o = await post<SgiOrder>("/sgi/orders", { sgiCode: sgiAccount.sgi_code, symbol: quote.symbol, side, type: effectiveType, quantity, limitPrice: effectiveType === "limit" ? limitPrice : undefined, validity: sgiValidity });
        setMsg({ ok: o.status !== "rejected", text: `Ordre réel n° ${o.id} : ${SGI_STATUS_LABEL[o.status]}${o.note ? ` · ${o.note}` : ""}` });
        return;
      }
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
      <div className="seg" style={{ marginBottom: 10, display: "flex" }}>
        <button style={{ flex: 1 }} className={!real ? "active" : ""} onClick={() => setMode("virtual")}>Portefeuille virtuel</button>
        <button style={{ flex: 1 }} className={real ? "active" : ""} onClick={() => setMode("real")} disabled={!sgiAccount} title={sgiAccount ? "" : "Ouvrez et faites valider un compte-titres chez une SGI partenaire"}>
          Réel via {sgiPartner?.shortName ?? "SGI"}
        </button>
      </div>
      {!sgiAccount && <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>Pour passer des ordres réels, <Link to="/sgi">ouvrez un compte-titres chez {sgiPartner?.shortName ?? "une SGI partenaire"}</Link>.</p>}
      <div className="field">
        <label>Type d'ordre</label>
        <select value={effectiveType} onChange={(e) => setType(e.target.value as OrderType)}>
          {(Object.keys(TYPE_LABEL) as OrderType[]).filter((t) => !real || t === "market" || t === "limit").map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {!real && (type === "stop" || type === "stop_limit") && (
          <div className="field">
            <label>Déclenchement (FCFA)</label>
            <input type="number" value={stopPrice} onChange={(e) => setStopPrice(Number(e.target.value))} />
          </div>
        )}
        {(effectiveType === "limit" || effectiveType === "stop_limit") && (
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
          {real ? (
            <select value={sgiValidity} onChange={(e) => setSgiValidity(e.target.value as "day" | "week" | "gtc")}>
              <option value="day">Jour</option>
              <option value="week">Semaine</option>
              <option value="gtc">Jusqu'à annulation</option>
            </select>
          ) : (
            <select value={validity} onChange={(e) => setValidity(e.target.value as "day" | "gtc")}>
              <option value="gtc">Jusqu'à annulation</option>
              <option value="day">Jour</option>
            </select>
          )}
        </div>
      </div>
      {!real && side === "buy" && (
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
        <li className="row"><span>Frais estimés {real ? `(courtage ${sgiPartner?.brokerageFeePct} % + BRVM/DC-BR ${sgiPartner?.marketFeePct} %)` : "(1,25 %)"}</span><span className="spacer" /><span className="mono">{fmtFcfa(fee)}</span></li>
        <li className="row"><b>{side === "buy" ? "Total à payer" : "Net encaissé"}</b><span className="spacer" /><b className="mono">{fmtFcfa(side === "buy" ? gross + fee : gross - fee)}</b></li>
      </ul>
      <button className={`btn ${side}`} style={{ width: "100%" }} disabled={busy} onClick={submit}>
        {real ? "Transmettre à " + (sgiPartner?.shortName ?? "la SGI") + " : " : ""}{side === "buy" ? "Acheter" : "Vendre"} {quantity} {quote.symbol}
      </button>
      {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
      {real ? (
        <p className="disclaimer">Ordre réel : transmis à {sgiPartner?.shortName}, seule habilitée à négocier sur la BRVM, pour exécution sur votre compte-titres n° {sgiAccount?.account_number}. Le prix d'un ordre au marché est celui obtenu par la SGI en séance. Suivi dans <Link to="/sgi">Compte-titres & ordres réels</Link>.</p>
      ) : (
        <p className="disclaimer">Portefeuille virtuel : les ordres sont simulés au cours affiché. Pour un ordre réel, basculez en mode « Réel via SGI ».</p>
      )}
    </div>
  );
}
