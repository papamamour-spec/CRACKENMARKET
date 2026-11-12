import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { compact, fmtDate, fmtNum } from "../lib/format";
import type { CompanyFundamentals } from "../lib/types";

/** Fondamentaux d'une société : ratios de valorisation et enregistrements par période. */
export function FundamentalsPanel({ symbol }: { symbol: string }) {
  const [data, setData] = useState<CompanyFundamentals | null>(null);
  useEffect(() => {
    setData(null);
    api<CompanyFundamentals>(`/market/fundamentals/${symbol}`).then(setData).catch(() => {});
  }, [symbol]);
  const m = data?.metrics;
  const v = (x: number | null | undefined, suffix = "", digits = 1) => (x == null ? "—" : `${fmtNum(x, digits)}${suffix}`);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Fondamentaux</h3>
          <span className="muted" style={{ fontSize: 12 }}>{data ? (data.records.length ? `${data.records.length} période(s) · exercice de référence ${m?.annualPeriod ?? "—"}${m?.latestPeriod && m.latestPeriod !== m.annualPeriod ? ` · dernière publication ${m.latestPeriod}` : ""}` : "aucune publication structurée : ratios indisponibles") : "…"}</span>
        </div>
        <Link to="/donnees" className="muted" style={{ fontSize: 12 }}>Saisie analyste →</Link>
      </div>
      {m && (
        <div className="grid grid-3" style={{ gap: 10 }}>
          <div className="kpi"><span className="label">PER</span><span className="value">{v(m.per)}</span><span className="sub muted">{m.eps != null ? `BPA ${fmtNum(m.eps)} FCFA · rendement bénéficiaire ${v(m.earningsYieldPct, " %")}` : m.missing[0] ?? "—"}</span></div>
          <div className="kpi"><span className="label">Cours / actif net</span><span className="value">{v(m.priceToBook)}</span><span className="sub muted">{m.bookValuePerShare != null ? `actif net ${fmtNum(m.bookValuePerShare)} FCFA par action · ROE ${v(m.roePct, " %")}` : "capitaux propres non renseignés"}</span></div>
          <div className="kpi"><span className="label">Croissance annuelle</span><span className={`value ${(m.netIncomeGrowthPct ?? 0) >= 0 ? "up" : "down"}`} style={{ fontSize: 18 }}>{m.netIncomeGrowthPct != null ? `${m.netIncomeGrowthPct > 0 ? "+" : ""}${m.netIncomeGrowthPct} %` : "—"}</span><span className="sub muted">résultat net · chiffre d'affaires {m.revenueGrowthPct != null ? `${m.revenueGrowthPct > 0 ? "+" : ""}${m.revenueGrowthPct} %` : "—"} · marge nette {v(m.netMarginPct, " %")} · distribution {v(m.payoutPct, " %", 0)}</span></div>
        </div>
      )}
      {data && data.records.length > 0 && (
        <table style={{ marginTop: 10 }}>
          <thead><tr><th className="left">Période</th><th>Chiffre d'affaires</th><th>Résultat net</th><th>Capitaux propres</th><th>BPA</th><th>Dividende</th><th className="left">Source</th></tr></thead>
          <tbody>
            {data.records.slice(0, 8).map((r) => (
              <tr key={r.id}>
                <td className="left mono">{r.period}</td>
                <td className="mono">{r.revenue != null ? compact(r.revenue) : "—"}{r.revenueGrowthPct != null ? <small className={r.revenueGrowthPct >= 0 ? "up" : "down"}> {r.revenueGrowthPct > 0 ? "+" : ""}{r.revenueGrowthPct} %</small> : null}</td>
                <td className="mono">{r.netIncome != null ? compact(r.netIncome) : "—"}{r.netIncomeGrowthPct != null ? <small className={r.netIncomeGrowthPct >= 0 ? "up" : "down"}> {r.netIncomeGrowthPct > 0 ? "+" : ""}{r.netIncomeGrowthPct} %</small> : null}</td>
                <td className="mono">{r.equity != null ? compact(r.equity) : "—"}</td>
                <td className="mono">{r.eps != null ? fmtNum(r.eps) : "—"}</td>
                <td className="mono">{r.dps != null ? fmtNum(r.dps) : "—"}</td>
                <td className="left muted" style={{ fontSize: 11 }}><span className={`badge ${r.status === "analyste" ? "buy" : "hold"}`}>{r.status}</span> {r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.source}</a> : r.source}{r.publishedAt ? ` · ${fmtDate(r.publishedAt)}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && !data.records.length && <p className="disclaimer">Les publications collectées sont lues automatiquement (chiffre d'affaires, résultat, capitaux propres, BPA, dividende) ; un analyste peut saisir ou corriger les chiffres. Les ratios alimentent le modèle de panel des prévisions.</p>}
    </div>
  );
}
