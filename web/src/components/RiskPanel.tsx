import { fmtFcfa, fmtPct, signClass } from "../lib/format";
import type { RiskReport } from "../lib/types";

const KIND_LABEL: Record<string, string> = { historique: "historique", choc: "choc", taux: "taux" };

/** Risque d'un portefeuille : modèle factoriel, perte (CVaR), liquidité, coûts et tests de résistance. */
export function RiskPanel({ r, total, compact = false }: { r: RiskReport; total: number; compact?: boolean }) {
  return (
    <div>
      <div className="grid grid-3" style={{ gap: 10 }}>
        <div className="kpi"><span className="label">Perte moyenne des pires mois (CVaR 95 %)</span><span className="value down">{r.loss.cvar95_1mPct} %</span><span className="sub muted">≈ {fmtFcfa(r.loss.amount)} · VaR {r.loss.var95_1mPct} % · perte max. historique {r.loss.maxDrawdownPct} %{r.loss.limitPct != null ? ` · limite du profil ${r.loss.limitPct} %${r.loss.limited ? " (appliquée)" : ""}` : ""}</span></div>
        <div className="kpi"><span className="label">Modèle de risque</span><span className="value">{r.model.kind === "factoriel" ? `${r.model.factors.length} facteurs` : "échantillon"}</span><span className="sub muted">{r.model.kind === "factoriel" ? `${r.model.factors.slice(0, 3).join(", ")}${r.model.factors.length > 3 ? ` + ${r.model.factors.length - 3} secteurs` : ""} · R² moyen ${Math.round(r.model.avgR2 * 100)} % · ${r.model.observations} séances · mélange ${r.model.blendPct} % facteurs` : "historique insuffisant pour le modèle factoriel"}</span></div>
        <div className="kpi"><span className="label">Coûts</span><span className="value">{r.costs.entryPct} %</span><span className="sub muted">frais d'entrée ≈ {fmtFcfa(r.costs.entryCost)} · aller-retour {r.costs.roundTripPct} % · {r.costs.annualDragPct} % par an amortis · rotation {r.costs.turnoverPct} %{r.costs.dividendTax.length ? ` · retenue sur dividendes ${r.costs.dividendTax.map((t) => `${t.country} ${t.pct} %`).join(", ")}` : ""}</span></div>
      </div>
      {(r.liquidity.capped.length > 0 || r.liquidity.lines.some((l) => l.daysToExit > r.liquidity.exitDays)) && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Liquidité ({r.liquidity.participationPct} % des capitaux échangés, sortie en {r.liquidity.exitDays} séances) :
          {r.liquidity.capped.length > 0 && <> plafonds {r.liquidity.capped.map((c) => `${c.symbol} ${c.capPct} %`).join(", ")}.</>}
          {r.liquidity.lines.filter((l) => l.daysToExit > r.liquidity.exitDays).length > 0 && <> Sortie lente : {r.liquidity.lines.filter((l) => l.daysToExit > r.liquidity.exitDays).map((l) => `${l.symbol} (${l.daysToExit} séances)`).join(", ")}.</>}
        </p>
      )}
      {r.stress.length > 0 && (
        <div className="table-scroll" style={{ marginTop: 8 }}>
          <table>
            <thead><tr><th className="left">Scénario</th><th className="left">Type</th><th>Actions</th><th>Obligations</th><th>Total</th><th>Montant</th>{!compact && <th className="left">Lecture</th>}</tr></thead>
            <tbody>
              {r.stress.map((s) => (
                <tr key={s.key}>
                  <td className="left">{s.label}</td>
                  <td className="left muted">{KIND_LABEL[s.kind]}</td>
                  <td className={`mono ${signClass(s.equityPct)}`}>{fmtPct(s.equityPct, 1)}</td>
                  <td className={`mono ${signClass(s.bondPct)}`}>{s.bondPct ? fmtPct(s.bondPct, 1) : "—"}</td>
                  <td className={`mono ${signClass(s.totalPct)}`}><b>{fmtPct(s.totalPct, 1)}</b></td>
                  <td className={`mono ${signClass(s.amount)}`}>{s.amount > 0 ? "+" : ""}{fmtFcfa(s.amount)}</td>
                  {!compact && <td className="left muted" style={{ whiteSpace: "normal", fontSize: 12, maxWidth: 360 }}>{s.note}{s.lines.length > 0 && s.kind !== "taux" ? ` Lignes les plus touchées : ${s.lines.slice(0, 3).map((l) => `${l.symbol} ${l.pct > 0 ? "+" : ""}${l.pct} %`).join(", ")}.` : ""}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 11 }}>Chocs appliqués à {fmtFcfa(total)} ; les fenêtres historiques rejouent l'historique disponible (réel dès qu'il est collecté, synthétique recalé avant), les chocs hypothétiques passent par le bêta de chaque valeur, les scénarios de taux par la duration de la poche obligataire.</p>
        </div>
      )}
    </div>
  );
}
