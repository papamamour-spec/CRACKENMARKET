import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, post } from "../lib/api";
import { fmtDate, fmtDateTime, fmtFcfa, fmtPct, signClass } from "../lib/format";
import type { TodayView } from "../lib/types";

/** Aujourd'hui : trois blocs, zéro jargon. À faire (ordres à passer, case « c'est fait »), où j'en suis, santé du moteur. */
export function TodayPage() {
  const [v, setV] = useState<TodayView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api<TodayView>("/today").then((r) => { setV(r); setErr(null); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);

  const toggle = async (positionId: number | null, kind: "acheter" | "vendre" | "échéance" | "info", done: boolean) => {
    if (positionId == null) return;
    try { setV(await post<TodayView>("/today/confirm", { positionId, kind: kind === "acheter" ? "achat" : "vente", done })); } catch (e) { setErr((e as Error).message); }
  };

  if (err && !v) return <div className="card"><p className="error">{err}</p></div>;
  if (!v) return <div className="card"><p className="muted">Chargement…</p></div>;
  const todo = v.actions.filter((a) => !a.done);
  const c = v.capital;
  const h = v.health;

  return (
    <div className="grid">
      <div className="today-head">
        <h1>Aujourd'hui</h1>
        <span className="muted">{fmtDate(v.date)} · {todo.length ? `${todo.length} chose(s) à faire` : "rien à faire"}</span>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>À faire</h2>
        {todo.length === 0 ? (
          <div className="todo-empty">Rien à faire aujourd'hui. {v.nextReview}</div>
        ) : (
          <ul className="todo">
            {todo.map((a) => (
              <li key={a.id} className={a.urgent ? "urgent" : ""}>
                {a.positionId != null ? <input type="checkbox" className="check" checked={a.done} onChange={(e) => toggle(a.positionId, a.kind, e.target.checked)} aria-label="C'est fait" /> : <span style={{ width: 22 }} />}
                <div>
                  <div className="text">{a.text}</div>
                  <div className="why">{a.why}</div>
                  {a.details.length > 0 && <details><summary>Pourquoi cette ligne</summary><ul className="clean" style={{ marginTop: 4 }}>{a.details.map((d, i) => <li key={i}>• {d}</li>)}</ul></details>}
                  {a.link && a.kind === "info" && <Link to={a.link} className="btn sm primary" style={{ marginTop: 8, display: "inline-block" }}>Ouvrir et publier</Link>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {todo.length > 0 && <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Cochez chaque ligne une fois l'ordre passé chez votre SGI : la plateforme sait alors ce que vous détenez réellement.</p>}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Où j'en suis</h2>
        <div className="grid grid-3" style={{ gap: 12 }}>
          <div className="kpi">
            <span className="label">Poche court terme</span>
            {c.shortTerm ? (
              <>
                <span className="big">{fmtFcfa(c.shortTerm.value)}</span>
                <span className="sub">{c.shortTerm.monthPct != null ? <>Ce mois : <b className={signClass(c.shortTerm.monthPct)}>{fmtPct(c.shortTerm.monthPct, 1)}</b> ({c.shortTerm.monthFcfa != null && c.shortTerm.monthFcfa >= 0 ? "+" : ""}{fmtFcfa(c.shortTerm.monthFcfa ?? 0)})</> : "Démarrée récemment"} · depuis le départ <b className={signClass(c.shortTerm.sincePct)}>{fmtPct(c.shortTerm.sincePct, 1)}</b>, soit <b className={signClass(c.shortTerm.alphaPct)}>{fmtPct(c.shortTerm.alphaPct, 1)}</b> par rapport à la Bourse</span>
                <span className="sub muted" style={{ marginTop: 6 }}>Investi {c.shortTerm.exposurePct} % sur {c.shortTerm.exposureCapPct} % autorisés · {c.shortTerm.open} ligne(s) · marge avant le plancher de protection {c.shortTerm.floorDistancePct} %</span>
                <div className="gauge" title="Part investie sur la part autorisée"><span style={{ width: `${Math.min(100, c.shortTerm.exposureCapPct ? (c.shortTerm.exposurePct / c.shortTerm.exposureCapPct) * 100 : 0)}%` }} /></div>
              </>
            ) : <span className="sub muted">Pas encore démarrée. Quand le feu est vert, l'action « publier le panier » apparaît ci-dessus.</span>}
          </div>
          <div className="kpi">
            <span className="label">Poche long terme</span>
            {c.longTerm ? (
              <>
                <span className="big">{fmtFcfa(c.longTerm.total)}</span>
                <span className="sub">{c.longTerm.pnlPct != null ? <>Plus-value <b className={signClass(c.longTerm.pnlPct)}>{fmtPct(c.longTerm.pnlPct, 1)}</b> · </> : null}dividendes {c.longTerm.dividendYieldPct} % par an · {c.longTerm.lines} ligne(s) · liquidités {fmtFcfa(c.longTerm.cash)}</span>
                <Link to="/mon-portefeuille" className="muted" style={{ fontSize: 12, marginTop: 6 }}>Voir les conseils sur cette poche →</Link>
              </>
            ) : <span className="sub muted">Aucun portefeuille saisi. <Link to="/mon-portefeuille">Saisir mes lignes</Link> pour recevoir des conseils dessus.</span>}
          </div>
          <div className="kpi">
            <span className="label">Total</span>
            <span className="big">{fmtFcfa(c.total)}</span>
            <span className="sub muted">Les deux poches sont séparées : le court terme ne dépasse jamais la part que vous lui avez donnée.</span>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Santé du moteur</h2>
        <div className="health">
          <span className={`health-dot ${h.light}`} aria-label={h.light} />
          <div>
            <h3>{h.title}</h3>
            <ul className="clean" style={{ fontSize: 13 }}>{h.reasons.map((r, i) => <li key={i}>• {r}</li>)}</ul>
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {h.regime ? `Marché ${h.regime.label.toLowerCase()}` : ""}{h.measuredAt ? ` · dernière mesure ${fmtDate(h.measuredAt)}` : ""}{h.modelAt ? ` · modèle du ${fmtDate(h.modelAt)}` : ""}{h.dataQualityScore != null ? ` · données ${h.dataQualityScore}/100` : ""}{h.lastSession ? ` · dernière séance ${fmtDate(h.lastSession)}` : ""}
              {" · "}le détail est dans le mode expert (<Link to="/court-terme">Court terme</Link>, <Link to="/previsions">Prévisions</Link>, <Link to="/qualite">Qualité</Link>).
            </p>
          </div>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 11 }}>Mis à jour {fmtDateTime(v.date)}.</p>
    </div>
  );
}
