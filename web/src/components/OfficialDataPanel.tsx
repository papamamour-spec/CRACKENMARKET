import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { fmtDate, fmtNum, fmtPct, signClass } from "../lib/format";
import { ACTION_KIND_LABEL, type BocSymbolResponse, type CorporateSymbolResponse } from "../lib/types";

const STATUS_CLASS: Record<string, string> = { proposé: "hold", approuvé: "buy", payé: "strong-buy" };

/** Données officielles d'une valeur : dividendes réels, opérations sur le capital, dernière séance du bulletin de la cote. */
export function OfficialDataPanel({ symbol }: { symbol: string }) {
  const [corp, setCorp] = useState<CorporateSymbolResponse | null>(null);
  const [boc, setBoc] = useState<BocSymbolResponse | null>(null);

  useEffect(() => {
    setCorp(null);
    setBoc(null);
    api<CorporateSymbolResponse>(`/market/corporate/${symbol}`).then(setCorp).catch(() => {});
    api<BocSymbolResponse>(`/market/boc/${symbol}?limit=10`).then(setBoc).catch(() => {});
  }, [symbol]);

  const info = corp?.info;
  const last = boc?.latest;
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Dividendes et données officielles</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {info ? (info.years ? `${info.years} exercice(s) renseigné(s)` : "aucun dividende renseigné : rendement estimé d'après le référentiel") : "…"}
            {corp?.adjustments.length ? ` · séries des modèles ajustées (${corp.adjustments.length} opération(s))` : ""}
          </span>
        </div>
        <Link to="/donnees" className="muted" style={{ fontSize: 12 }}>Saisie analyste →</Link>
      </div>
      <div className="grid grid-3" style={{ gap: 10 }}>
        <div className="kpi">
          <span className="label">Dernier dividende net</span>
          <span className="value">{info?.last?.netEstimated != null ? `${fmtNum(info.last.netEstimated)} FCFA` : "—"}</span>
          <span className="sub muted">{info?.last ? `exercice ${info.last.fiscalYear} · ${info.last.status}${info.last.net == null && info.last.gross != null ? " · net estimé (brut − 10 %)" : ""}` : "non renseigné"}</span>
        </div>
        <div className="kpi">
          <span className="label">Rendement net réel</span>
          <span className="value">{info?.yieldPct != null ? `${info.yieldPct.toFixed(1)} %` : "—"}</span>
          <span className="sub muted">sur le dernier dividende et le cours actuel</span>
        </div>
        <div className="kpi">
          <span className="label">Prochain détachement</span>
          <span className="value" style={{ fontSize: 16 }}>{info?.next ? fmtDate(info.next.exDate) : "—"}</span>
          <span className="sub muted">{info?.next ? `${fmtNum(info.next.amount)} FCFA net (${info.next.status}, exercice ${info.next.fiscalYear})` : "aucune date publiée"}</span>
        </div>
      </div>
      {corp && corp.dividends.length > 0 && (
        <table style={{ marginTop: 10 }}>
          <thead><tr><th className="left">Exercice</th><th>Brut</th><th>Net</th><th>Détachement</th><th>Paiement</th><th className="left">Statut · source</th></tr></thead>
          <tbody>
            {corp.dividends.slice(0, 6).map((d) => (
              <tr key={d.id}>
                <td className="left mono">{d.fiscalYear}</td>
                <td className="mono">{d.gross != null ? fmtNum(d.gross) : "—"}</td>
                <td className="mono">{d.net != null ? fmtNum(d.net) : d.netEstimated != null ? <span className="muted" title="Net estimé après retenue à la source de 10 %">≈ {fmtNum(d.netEstimated)}</span> : "—"}</td>
                <td className="mono">{d.exDate ? fmtDate(d.exDate) : "—"}</td>
                <td className="mono">{d.paymentDate ? fmtDate(d.paymentDate) : "—"}</td>
                <td className="left"><span className={`badge ${STATUS_CLASS[d.status] ?? "hold"}`}>{d.status}</span> <span className="muted" style={{ fontSize: 11 }}>{d.url ? <a href={d.url} target="_blank" rel="noreferrer">{d.source}</a> : d.source}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {corp && corp.actions.length > 0 && (
        <ul className="clean" style={{ marginTop: 8, fontSize: 12 }}>
          {corp.actions.map((a) => (
            <li key={a.id}>• {ACTION_KIND_LABEL[a.kind]} {a.kind === "bonus" ? `1 pour ${a.ratio}` : a.kind === "split" ? `1 → ${a.ratio}` : `${a.ratio} → 1`} le {fmtDate(a.exDate)} <span className={`badge ${a.status === "confirmé" ? "buy" : "reduce"}`}>{a.status}</span> <span className="muted">{a.source}</span></li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: 10 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <b style={{ fontSize: 13 }}>Bulletin officiel de la cote</b>
          <span className="muted" style={{ fontSize: 11 }}>{last ? `séance du ${fmtDate(last.ts)} · ${last.source}` : "aucune séance collectée"}</span>
        </div>
        {last ? (
          <table style={{ marginTop: 6 }}>
            <tbody>
              <tr><td className="left muted">Clôture / variation</td><td className="mono">{last.close != null ? fmtNum(last.close) : "—"} <span className={signClass(last.changePct ?? 0)}>{last.changePct != null ? fmtPct(last.changePct, 2) : ""}</span></td><td className="left muted">Transactions</td><td className="mono">{last.trades ?? "—"}</td></tr>
              <tr><td className="left muted">Volume / capitaux</td><td className="mono">{last.volume != null ? fmtNum(last.volume) : "—"} / {last.value != null ? fmtNum(last.value) : "—"}</td><td className="left muted">Meilleure demande / offre</td><td className="mono"><span className="up">{last.bid != null ? fmtNum(last.bid) : "—"}</span>{last.bidQty != null ? ` ×${fmtNum(last.bidQty)}` : ""} / <span className="down">{last.ask != null ? fmtNum(last.ask) : "—"}</span>{last.askQty != null ? ` ×${fmtNum(last.askQty)}` : ""}</td></tr>
              <tr><td className="left muted">Déséquilibre du carnet</td><td className={`mono ${last.imbalance != null ? signClass(last.imbalance) : ""}`}>{last.imbalance != null ? `${last.imbalance > 0 ? "+" : ""}${Math.round(last.imbalance * 100)} %` : "—"}</td><td className="left muted">État</td><td className="mono">{last.suspended ? <span className="badge avoid">suspendu</span> : last.reserved ? <span className={`badge ${last.reserved === "up" ? "buy" : "reduce"}`}>réservé à la {last.reserved === "up" ? "hausse" : "baisse"}</span> : "négocié normalement"}</td></tr>
              {boc && boc.activity.sessions > 1 && <tr><td className="left muted">{boc.activity.sessions} dernières séances</td><td className="mono" colSpan={3}>{boc.activity.avgTrades != null ? `${boc.activity.avgTrades} transactions / séance` : "transactions inconnues"} · {boc.activity.reservedUp} réservation(s) à la hausse · {boc.activity.reservedDown} à la baisse{boc.activity.suspendedDays ? ` · ${boc.activity.suspendedDays} séance(s) suspendue(s)` : ""}</td></tr>}
            </tbody>
          </table>
        ) : (
          <p className="disclaimer" style={{ marginTop: 4 }}>Le bulletin apporte le nombre de transactions, les meilleures limites et les réservations, utilisés par les prévisions dès qu'il est collecté (source `BOC_SOURCES` ou import par un administrateur).</p>
        )}
      </div>
    </div>
  );
}
