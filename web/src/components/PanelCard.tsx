import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { fmtDate, fmtDateTime } from "../lib/format";
import { HORIZON_LABEL, type Horizon, type PanelSummary } from "../lib/types";

/** Modèle de panel : régression commune à la cote, rendements relatifs attendus et précision de test. */
export function PanelCard({ horizon }: { horizon: Horizon }) {
  const [data, setData] = useState<PanelSummary | null>(null);
  useEffect(() => {
    const load = () => api<PanelSummary>(`/market/panel?horizon=${horizon}`).then(setData).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [horizon]);
  const st = data?.stats.find((s) => s.horizon === horizon) ?? null;
  const top = data?.ranking.slice(0, 5) ?? [];
  const bottom = data?.ranking.slice(-5).reverse() ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Modèle de panel</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            Une seule régression pour toute la cote, sur le rendement relatif de chaque valeur à la moyenne des valeurs : momentum, retour à la moyenne, volatilité, volumes, rangs transversaux, rendement du dividende, rendement bénéficiaire, détachement proche. Troisième modèle de l'ensemble, pondéré par son erreur de test.
            {data?.asOf ? ` Entraîné au ${fmtDate(data.asOf)} sur ${data.symbols} valeurs${data.computedAt ? ` (calcul ${fmtDateTime(data.computedAt)})` : ""}.` : " Calcul en cours…"}
          </span>
        </div>
      </div>
      {st && (
        <div className="grid grid-3" style={{ gap: 10 }}>
          <div className="kpi"><span className="label">Observations ({HORIZON_LABEL[horizon]})</span><span className="value">{st.samples}</span><span className="sub muted">{st.testSamples} en test chronologique · λ {st.lambda}</span></div>
          <div className="kpi"><span className="label">Erreur en test</span><span className={`value ${st.testMaePct != null && st.naiveMaePct != null && st.testMaePct <= st.naiveMaePct ? "up" : "down"}`}>{st.testMaePct != null ? `${st.testMaePct} %` : "—"}</span><span className="sub muted">sans modèle {st.naiveMaePct != null ? `${st.naiveMaePct} %` : "—"}</span></div>
          <div className="kpi"><span className="label">Direction relative correcte</span><span className="value">{st.hitRate != null ? `${Math.round(st.hitRate * 100)} %` : "—"}</span><span className="sub muted">valeur au-dessus ou en dessous de la moyenne</span></div>
        </div>
      )}
      {data && data.ranking.length > 0 && (
        <div className="grid grid-2" style={{ gap: 14, marginTop: 10 }}>
          {[["Attendues au-dessus de la cote", top], ["Attendues en dessous de la cote", bottom]].map(([title, rows]) => (
            <div key={title as string}>
              <h4>{title as string}</h4>
              <table>
                <tbody>
                  {(rows as PanelSummary["ranking"]).map((r) => (
                    <tr key={r.symbol}>
                      <td><Link to={`/valeur/${r.symbol}`} className="sym">{r.symbol}<small>{r.name}</small></Link></td>
                      <td className={`mono ${r.relPct >= 0 ? "up" : "down"}`}>{r.relPct > 0 ? "+" : ""}{r.relPct.toFixed(1)} pt</td>
                      <td className="left muted" style={{ fontSize: 11, whiteSpace: "normal" }}>{r.top ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
