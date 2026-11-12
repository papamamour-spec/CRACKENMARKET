import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { api, put } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { QUALITY_BAND_CLASS, type CompanyProfile, type QualityResult } from "../lib/types";
import { ScoreBar } from "./ScoreBar";
import { SkeletonCard } from "./Skeleton";

/** Score de qualité et de risque d'un titre : règles publiées, parties, drapeaux, données non vérifiées ; profil éditable par les analystes. */
export function QualityCard({ symbol }: { symbol: string }) {
  const { user } = useAuth();
  const analyst = user?.role === "analyst" || user?.role === "admin";
  const [q, setQ] = useState<(QualityResult & { profile: CompanyProfile }) | null>(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api<QualityResult & { profile: CompanyProfile }>(`/market/quality/${symbol}`).then((r) => { setQ(r); setForm({ freeFloatPct: r.profile.freeFloatPct?.toString() ?? "", mainHolderPct: r.profile.mainHolderPct?.toString() ?? "", mainHolderName: r.profile.mainHolderName ?? "", statePct: r.profile.statePct?.toString() ?? "", payoutRatioPct: r.profile.payoutRatioPct?.toString() ?? "", dividendYears: r.profile.dividendYears?.toString() ?? "", suspended: r.profile.suspended ? "1" : "", suspendedReason: r.profile.suspendedReason ?? "", note: r.profile.note ?? "" }); }).catch(() => {});
  useEffect(() => { setQ(null); setEdit(false); load(); }, [symbol]);
  const save = async () => {
    const num = (k: string) => (form[k] === "" ? null : Number(form[k].replace(",", ".")));
    try {
      await put(`/market/profile/${symbol}`, { freeFloatPct: num("freeFloatPct"), mainHolderPct: num("mainHolderPct"), mainHolderName: form.mainHolderName || null, statePct: num("statePct"), payoutRatioPct: num("payoutRatioPct"), dividendYears: num("dividendYears"), suspended: form.suspended === "1", suspendedReason: form.suspendedReason || null, note: form.note || null });
      setMsg("Profil enregistré, score recalculé.");
      setEdit(false);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  if (!q) return <SkeletonCard lines={5} />;
  return (
    <div className="card">
      <div className="card-head">
        <div><h3 style={{ margin: 0 }}>Qualité et risque du titre</h3><span className="muted" style={{ fontSize: 12 }}>Règles publiées (version {q.rulesVersion}) : cinq parties, drapeaux rouges, plafonds. Confiance {Math.round(q.confidence * 100)} % du barème vérifié.</span></div>
        <div style={{ textAlign: "right" }}><span className={`badge ${QUALITY_BAND_CLASS[q.band]}`} style={{ fontSize: 13 }}>{q.band}</span><div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{q.score}<span className="muted" style={{ fontSize: 12 }}> / 100</span></div></div>
      </div>
      <p style={{ margin: "4px 0 10px", fontSize: 13 }}>{q.headline}</p>
      {q.parts.map((p) => (
        <div key={p.key} className="gauge" style={{ marginBottom: 6 }}>
          <span style={{ width: 170, fontSize: 12 }} className={p.verified ? "" : "muted"}>{p.label}{p.verified ? "" : " · non vérifié"}</span>
          <ScoreBar value={p.verified ? Math.round((p.points / p.max) * 100) : 0} positive />
          <span className="mono" style={{ width: 54, fontSize: 12 }}>{p.verified ? `${p.points} / ${p.max}` : `— / ${p.max}`}</span>
        </div>
      ))}
      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: "pointer", fontSize: 13 }}>Détail de chaque partie</summary>
        <ul className="clean" style={{ fontSize: 12 }}>{q.parts.map((p) => <li key={p.key}>• <b>{p.label}</b> ({p.value}) : {p.text}</li>)}</ul>
      </details>
      {q.flags.length > 0 && <ul className="clean" style={{ marginTop: 8 }}>{q.flags.map((f, i) => <li key={i} style={{ color: f.hard ? "var(--down)" : "var(--warn)", fontSize: 13 }}>{f.hard ? "⛔ Drapeau rouge" : "⚠ Plafond"} · {f.text}</li>)}</ul>}
      {q.unverified.length > 0 && <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Non vérifié : {q.unverified.join(", ")}. Une donnée absente n'est jamais comptée comme bonne ; {analyst ? "renseignez le profil ci-dessous ou lancez la collecte des documents." : "un analyste peut compléter le profil de l'émetteur."}</p>}
      {analyst && (
        <div style={{ marginTop: 8 }}>
          {!edit && <button className="btn sm" onClick={() => setEdit(true)}>Renseigner le profil de l'émetteur</button>}
          {edit && (
            <div className="grid grid-3" style={{ gap: 8 }}>
              {([["freeFloatPct", "Flottant (%)"], ["mainHolderPct", "Actionnaire principal (%)"], ["mainHolderName", "Nom de l'actionnaire principal"], ["statePct", "Part de l'État (%)"], ["payoutRatioPct", "Taux de distribution (%)"], ["dividendYears", "Années consécutives de dividende"]] as const).map(([k, l]) => (
                <div className="field" key={k} style={{ marginBottom: 4 }}><label>{l}</label><input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></div>
              ))}
              <div className="field" style={{ marginBottom: 4 }}><label>Cotation suspendue</label><select value={form.suspended} onChange={(e) => setForm({ ...form, suspended: e.target.value })}><option value="">Non</option><option value="1">Oui</option></select></div>
              <div className="field" style={{ marginBottom: 4 }}><label>Motif de suspension</label><input value={form.suspendedReason} onChange={(e) => setForm({ ...form, suspendedReason: e.target.value })} /></div>
              <div className="field" style={{ marginBottom: 4, gridColumn: "1 / -1" }}><label>Note (source des chiffres)</label><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Ex. rapport annuel 2025, p. 12" /></div>
              <div className="row" style={{ gridColumn: "1 / -1" }}><button className="btn primary sm" onClick={save}>Enregistrer</button><button className="btn sm" onClick={() => setEdit(false)}>Annuler</button></div>
            </div>
          )}
          {q.profile.updatedAt && <span className="muted" style={{ fontSize: 11 }}> Profil mis à jour le {fmtDateTime(q.profile.updatedAt)}{q.profile.note ? ` · ${q.profile.note}` : ""}</span>}
          {msg && <p className="muted" style={{ fontSize: 12 }}>{msg}</p>}
        </div>
      )}
      <p className="disclaimer">Le score mesure la qualité du titre comme instrument (liquidité, stabilité, information, actionnariat, rendement), pas son potentiel de hausse. Règles complètes : docs/REGLES_SCORE.md.</p>
    </div>
  );
}
