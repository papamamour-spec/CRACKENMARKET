import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { fmtDate, fmtPct, signClass } from "../lib/format";
import type { AttributionReport } from "../lib/types";

/** Barre horizontale centrée sur zéro pour un effet en points de pourcentage. */
function Bar({ v, max }: { v: number; max: number }) {
  const w = max > 0 ? Math.min(100, (Math.abs(v) / max) * 50) : 0;
  return <div className="attr-bar"><div className={`attr-fill ${v >= 0 ? "pos" : "neg"}`} style={{ width: `${w}%`, marginLeft: v >= 0 ? "50%" : `${50 - w}%` }} /></div>;
}

/** Attribution de performance : d'où vient l'écart à l'indice (allocation, sélection, liquidités, coûts, dividendes), par secteur et par ligne. */
export function AttributionPanel({ url, compact = false }: { url: string; compact?: boolean }) {
  const [r, setR] = useState<AttributionReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setR(null); setErr(null); api<AttributionReport>(url).then(setR).catch((e) => setErr((e as Error).message)); }, [url]);
  if (err) return <p className="muted" style={{ fontSize: 12 }}>Attribution indisponible : {err}</p>;
  if (!r) return <p className="muted" style={{ fontSize: 12 }}>Calcul de l'attribution…</p>;
  const effects = [
    { label: "Allocation sectorielle", v: r.effects.allocationPct, hint: "sur- ou sous-pondérer un secteur qui a battu l'indice (ou non)" },
    { label: "Sélection de titres", v: r.effects.selectionPct, hint: "choisir, dans chaque secteur, des titres meilleurs (ou moins bons) que la moyenne du secteur" },
    { label: "Interaction", v: r.effects.interactionPct, hint: "croisement des deux effets" },
    { label: "Liquidités", v: r.effects.cashPct, hint: "la part non investie ne suit pas l'indice" },
    { label: "Coûts", v: r.effects.costsPct, hint: "frais d'entrée et de sortie" },
  ];
  const max = Math.max(0.1, ...effects.map((e) => Math.abs(e.v)), ...r.sectors.map((s) => Math.abs(s.totalPct)));
  return (
    <div>
      <div className="grid grid-4" style={{ gap: 10 }}>
        <div className="kpi"><span className="label">Portefeuille · {r.period.label}</span><span className={`value ${signClass(r.summary.portfolioPct)}`}>{fmtPct(r.summary.portfolioPct, 2)}</span><span className="sub muted">brut · net de frais {fmtPct(r.summary.netPct, 2)} · {r.summary.investedWeightPct} % investis au départ · {r.period.sessions} séance(s)</span></div>
        <div className="kpi"><span className="label">BRVM Composite</span><span className={`value ${signClass(r.summary.benchmarkPct)}`}>{fmtPct(r.summary.benchmarkPct, 2)}</span><span className="sub muted">référence reconstituée (cours × volumes), du {fmtDate(r.period.from)} au {fmtDate(r.period.to)}</span></div>
        <div className="kpi"><span className="label">Écart à l'indice</span><span className={`value ${signClass(r.summary.activePct)}`}>{fmtPct(r.summary.activePct, 2)}</span><span className="sub muted">= allocation {fmtPct(r.effects.allocationPct, 2)} + sélection {fmtPct(r.effects.selectionPct, 2)} + interaction {fmtPct(r.effects.interactionPct, 2)} + liquidités {fmtPct(r.effects.cashPct, 2)}{Math.abs(r.effects.residualPct) >= 0.05 ? ` + résidu ${fmtPct(r.effects.residualPct, 2)}` : ""}</span></div>
        <div className="kpi"><span className="label">Dividendes et marché</span><span className={`value ${signClass(r.effects.dividendsPct)}`}>{fmtPct(r.effects.dividendsPct, 2)}</span><span className="sub muted">part des dividendes dans le rendement{r.factors.beta != null ? ` · bêta ${r.factors.beta} : marché ${fmtPct(r.factors.marketContributionPct ?? 0, 2)}, propre au portefeuille ${fmtPct(r.factors.specificPct ?? 0, 2)}` : ""}</span></div>
      </div>
      <div className="two-col" style={{ marginTop: 12, gridTemplateColumns: "1.1fr 1fr" }}>
        <div style={{ minWidth: 0 }}>
          <h4 style={{ margin: "0 0 6px" }}>Effets, en points</h4>
          <table>
            <tbody>{effects.map((e) => <tr key={e.label} title={e.hint}><td className="left">{e.label}</td><td style={{ width: 160 }}><Bar v={e.v} max={max} /></td><td className={`mono ${signClass(e.v)}`}>{fmtPct(e.v, 2)}</td></tr>)}</tbody>
          </table>
          <h4 style={{ margin: "12px 0 6px" }}>Par secteur</h4>
          <div className="table-scroll"><table>
            <thead><tr><th className="left">Secteur</th><th>Poids</th><th>Indice</th><th>Rdt</th><th>Rdt indice</th><th>Allocation</th><th>Sélection</th><th>Total</th></tr></thead>
            <tbody>{r.sectors.filter((s) => s.weightPortfolioPct > 0 || Math.abs(s.totalPct) >= 0.05).map((s) => <tr key={s.sector}><td className="left">{s.sector}</td><td className="mono">{s.weightPortfolioPct} %</td><td className="mono muted">{s.weightBenchmarkPct} %</td><td className={`mono ${signClass(s.returnPortfolioPct ?? 0)}`}>{s.returnPortfolioPct != null ? fmtPct(s.returnPortfolioPct, 1) : "—"}</td><td className={`mono ${signClass(s.returnBenchmarkPct ?? 0)}`}>{s.returnBenchmarkPct != null ? fmtPct(s.returnBenchmarkPct, 1) : "—"}</td><td className={`mono ${signClass(s.allocationPct)}`}>{fmtPct(s.allocationPct, 2)}</td><td className={`mono ${signClass(s.selectionPct)}`}>{fmtPct(s.selectionPct, 2)}</td><td className={`mono ${signClass(s.totalPct)}`}><b>{fmtPct(s.totalPct, 2)}</b></td></tr>)}</tbody>
          </table></div>
        </div>
        <div style={{ minWidth: 0 }}>
          <h4 style={{ margin: "0 0 6px" }}>Contribution par ligne</h4>
          <div className="table-scroll"><table>
            <thead><tr><th className="left">Valeur</th><th>Contribution</th><th>Rdt</th><th>Poids départ</th><th>Écart indice</th>{!compact && <th>dont div.</th>}</tr></thead>
            <tbody>{r.lines.map((l) => <tr key={l.symbol}><td><Link to={`/valeur/${l.symbol}`} className="sym">{l.symbol}<small>{l.sector}</small></Link></td><td className={`mono ${signClass(l.contributionPct)}`}><b>{fmtPct(l.contributionPct, 2)}</b></td><td className={`mono ${signClass(l.returnPct)}`}>{fmtPct(l.returnPct, 1)}</td><td className="mono">{l.weightStartPct} %</td><td className={`mono ${signClass(l.activeWeightPct)}`}>{fmtPct(l.activeWeightPct, 1)}</td>{!compact && <td className="mono muted">{l.dividendPct != null ? fmtPct(l.dividendPct, 1) : "—"}</td>}</tr>)}</tbody>
          </table></div>
          {r.notes.length > 0 && <p className="muted" style={{ fontSize: 11 }}>{r.notes.join(" · ")}</p>}
        </div>
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>Méthode de Brinson-Fachler sur la période, quantités constantes (les poids dérivent avec les cours) ; les contributions des lignes somment au rendement de la poche investie ; la référence est le BRVM Composite reconstitué avec les pondérations de la plateforme.</p>
    </div>
  );
}
