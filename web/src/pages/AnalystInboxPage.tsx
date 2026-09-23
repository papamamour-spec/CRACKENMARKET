import { useEffect, useState } from "react";
import { AdvisoryReportView } from "../components/AdvisoryReportView";
import { api, post } from "../lib/api";
import { fmtDateTime, fmtFcfa } from "../lib/format";
import { ADVISORY_STATUS_LABEL, type AdvisoryView } from "../lib/types";

/** File de revue des analystes : chaque proposition Kraken est relue, annotée et validée avant d'être présentée comme conseil. */
export function AnalystInboxPage() {
  const [data, setData] = useState<{ requests: AdvisoryView[]; stats: { status: string; requester_type: string; n: number; capital: number }[] } | null>(null);
  const [open, setOpen] = useState<AdvisoryView | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const load = () => {
    api<typeof data>("/advisory/inbox").then(setData).catch((e) => setError(e.message));
  };
  useEffect(load, []);
  if (error) return <div className="card error">{error}</div>;
  if (!data) return <div className="card">Chargement…</div>;
  const pending = data.requests.filter((r) => r.status === "generated");
  const total = (k: string) => data.stats.filter((s) => s.requester_type === k).reduce((a, s) => a + s.capital, 0);
  const review = async (decision: "validated" | "declined") => {
    if (!open) return;
    try {
      const v = await post<AdvisoryView>(`/advisory/requests/${open.id}/review`, { decision, note: note || undefined });
      setOpen(v);
      setNote("");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const regenerate = async () => {
    if (!open) return;
    const v = await post<AdvisoryView>(`/advisory/requests/${open.id}/regenerate`, {});
    setOpen(v);
    load();
  };
  return (
    <div className="grid">
      <div className="card row">
        <div><h1>Revue des propositions de placement</h1><span className="muted">Chaque proposition générée par Kraken est relue par un analyste avant d'être présentée comme conseil validé.</span></div>
        <span className="spacer" />
        <div className="kpi"><span className="label">À relire</span><span className="value">{pending.length}</span></div>
        <div className="kpi"><span className="label">Capitaux particuliers</span><span className="value">{fmtFcfa(total("client"))}</span></div>
        <div className="kpi"><span className="label">Capitaux SGI</span><span className="value">{fmtFcfa(total("sgi"))}</span></div>
      </div>
      <div className="two-col">
        <div className="card">
          <h2>Demandes</h2>
          <table>
            <thead><tr><th className="left">Reçue</th><th className="left">Demandeur</th><th>Capital</th><th className="left">Objectif · horizon</th><th className="left">Statut</th></tr></thead>
            <tbody>
              {data.requests.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer", background: open?.id === r.id ? "var(--bg-3)" : undefined }} onClick={() => { setOpen(r); setNote(r.analyst_note ?? ""); }}>
                  <td className="left mono muted">{fmtDateTime(r.created_at)}</td>
                  <td className="left">{r.requester_type === "sgi" ? <>SGI {r.sgi_code} · {r.client_label}<br /><span className="muted" style={{ fontSize: 11 }}>par {r.requester_name}</span></> : <>{r.requester_name}<br /><span className="muted" style={{ fontSize: 11 }}>{r.requester_email}</span></>}</td>
                  <td className="mono">{fmtFcfa(r.capital)}</td>
                  <td className="left muted">{{ income: "Revenus", growth: "Croissance", balanced: "Équilibré", speculative: "Spéculatif" }[r.objective]} · {r.horizon_months} mois · risque {r.risk_tolerance}/5</td>
                  <td className="left"><span className={`badge ${r.status === "validated" ? "buy" : r.status === "declined" ? "sell" : "hold"}`}>{ADVISORY_STATUS_LABEL[r.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h2>Avis de l'analyste</h2>
          {!open ? (
            <p className="muted">Sélectionnez une demande.</p>
          ) : (
            <>
              <div className="field"><label>Note transmise au demandeur</label><textarea value={note} onChange={(e) => setNote(e.target.value)} rows={5} style={{ width: "100%", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: 8 }} placeholder="Points d'attention, ajustements recommandés, contexte de marché…" /></div>
              <div className="row">
                <button className="btn buy" onClick={() => review("validated")}>Valider la proposition</button>
                <button className="btn sell" onClick={() => review("declined")}>Ne pas retenir</button>
                <button className="btn" onClick={regenerate}>Régénérer avec le marché du jour</button>
              </div>
            </>
          )}
        </div>
      </div>
      {open && (
        <div className="card">
          <div className="card-head"><h2>Proposition n° {open.id}</h2><button className="btn sm" onClick={() => setOpen(null)}>Fermer</button></div>
          <AdvisoryReportView v={open} />
        </div>
      )}
    </div>
  );
}
