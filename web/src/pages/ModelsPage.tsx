import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PerformanceChart } from "../components/PerformanceChart";
import { AttributionPanel } from "../components/AttributionPanel";
import { useAuth } from "../hooks/useAuth";
import { api, post } from "../lib/api";
import { fmtDate, fmtDateTime, fmtFcfa, fmtNum, fmtPct, signClass } from "../lib/format";
import type { ModelDetail, ModelPlan, ModelView } from "../lib/types";

/** Portefeuilles modèles par profil : version publiée, proposition du moteur, performance nette de frais, plan vers mon portefeuille. */
export function ModelsPage() {
  const { user } = useAuth();
  const analyst = user?.role === "analyst" || user?.role === "admin";
  const [items, setItems] = useState<ModelView[]>([]);
  const [status, setStatus] = useState<{ models: number; published: number; lastProposedAt: number | null; computing: boolean } | null>(null);
  const [selected, setSelected] = useState<string>("equilibre");
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [plan, setPlan] = useState<ModelPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [note, setNote] = useState("");

  const load = () => api<{ items: ModelView[]; status: typeof status }>("/models").then((r) => { setItems(r.items); setStatus(r.status); }).catch(() => {});
  const loadDetail = (key: string) => { api<ModelDetail>(`/models/${key}`).then(setDetail).catch(() => setDetail(null)); setPlan(null); };
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);
  useEffect(() => { loadDetail(selected); }, [selected]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const recompute = () => run(async () => {
    const r = await post<{ computed: string[]; published: string[]; failed: string[] }>("/models/recompute", {});
    await load();
    loadDetail(selected);
    return `Propositions recalculées : ${r.computed.join(", ") || "aucune"}${r.published.length ? ` · publiées automatiquement : ${r.published.join(", ")}` : ""}${r.failed.length ? ` · échecs : ${r.failed.join(" ; ")}` : ""}.`;
  });
  const publish = () => run(async () => {
    await post(`/models/${selected}/publish`, { note: note || null });
    await load();
    loadDetail(selected);
    setNote("");
    return "Proposition publiée : elle devient la version de référence et son suivi net de frais démarre.";
  });
  const loadPlan = () => run(async () => {
    const p = await api<ModelPlan>(`/models/${selected}/plan`);
    setPlan(p);
    return p.verdict;
  });

  const m = items.find((x) => x.key === selected) ?? null;
  const v = m?.current ?? null;

  return (
    <div className="grid">
      <div className="card">
        <div className="card-head">
          <div><h1>Portefeuilles modèles</h1><span className="muted">Quatre portefeuilles de référence calculés par le moteur (Black-Litterman, covariance factorielle, limite de perte, liquidité, coûts, poche obligataire) sur un capital nominal de 10 M FCFA. Le moteur propose chaque jour après la clôture ; l'analyste publie. Chaque version publiée est suivie nette de frais contre le BRVM Composite et le BRVM 30.</span></div>
          {analyst && <button className="btn sm" disabled={busy || !!status?.computing} onClick={recompute}>{status?.computing ? "Calcul en cours…" : "Recalculer les propositions"}</button>}
        </div>
        {status && <p className="muted" style={{ fontSize: 12 }}>{status.published} modèle(s) publié(s) sur {status.models}{status.lastProposedAt ? ` · dernière proposition ${fmtDateTime(status.lastProposedAt)}` : " · aucune proposition encore calculée (calcul automatique deux minutes après le démarrage)"}.</p>}
        {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
      </div>

      <div className="grid grid-4">
        {items.map((x) => (
          <button key={x.key} className={`card model-card ${x.key === selected ? "sel" : ""}`} onClick={() => setSelected(x.key)} style={{ textAlign: "left", cursor: "pointer" }}>
            <div className="row" style={{ justifyContent: "space-between" }}><h3 style={{ margin: 0 }}>{x.label}</h3>{x.current ? <span className={`badge ${x.status === "validated" ? "buy" : "hold"}`}>{x.status === "validated" ? `v${x.version} validée` : `v${x.version} auto`}</span> : <span className="badge avoid">non publié</span>}</div>
            <p className="muted" style={{ fontSize: 12, minHeight: 48 }}>{x.description}</p>
            {x.current ? (
              <>
                <div className="classbar" title={`Actions ${x.current.equityPct} %, obligations ${x.current.bondPct} %, liquidités ${x.current.cashPct} %`}><span className="eq" style={{ width: `${x.current.equityPct}%` }} /><span className="bd" style={{ width: `${x.current.bondPct}%` }} /><span className="cs" style={{ width: `${x.current.cashPct}%` }} /></div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{x.current.lines.length} actions · {x.current.bonds.length} obligations · rendement attendu net {fmtPct(x.current.metrics.netExpectedAnnualReturnPct, 1)} / an · volatilité {x.current.metrics.volatilityPct} %{x.current.metrics.cvar95_1mPct != null ? ` · CVaR ${x.current.metrics.cvar95_1mPct} %` : ""}</div>
                <div style={{ fontSize: 13, marginTop: 6 }}>{x.performance ? <>Depuis publication : <b className={signClass(x.performance.returnNetPct)}>{fmtPct(x.performance.returnNetPct, 2)}</b> net · écart / Composite <b className={signClass(x.performance.alphaCompositePct)}>{fmtPct(x.performance.alphaCompositePct, 2)}</b></> : <span className="muted">suivi en attente</span>}</div>
                {x.drift && x.drift.trades.length > 0 && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Proposition : {x.drift.trades.length} ligne(s) hors bande, rendement net {x.drift.returnGapPct > 0 ? "+" : ""}{x.drift.returnGapPct} pt</div>}
              </>
            ) : <p className="muted" style={{ fontSize: 12 }}>{x.proposal ? "Proposition prête, en attente de publication." : "En attente du premier calcul."}</p>}
          </button>
        ))}
      </div>

      {m && v && (
        <div className="card">
          <div className="card-head">
            <div><h2>Modèle {m.label} · version {m.version}{m.publishedAt ? ` publiée le ${fmtDate(m.publishedAt)}` : ""}</h2><span className="muted" style={{ fontSize: 12 }}>{m.note ? `Note de l'analyste : ${m.note}` : m.status === "auto" ? "Publié automatiquement au premier calcul, sans relecture." : ""}</span></div>
            <div className="row"><button className="btn sm" disabled={busy} onClick={loadPlan}>Plan pour mon portefeuille</button></div>
          </div>
          <div className="grid grid-4" style={{ gap: 10 }}>
            <div className="kpi"><span className="label">Rendement attendu</span><span className={`value ${signClass(v.metrics.expectedAnnualReturnPct)}`}>{fmtPct(v.metrics.expectedAnnualReturnPct, 1)}</span><span className="sub muted">net de coûts {fmtPct(v.metrics.netExpectedAnnualReturnPct, 1)} · dividendes {v.metrics.dividendYieldPct} %</span></div>
            <div className="kpi"><span className="label">Risque</span><span className="value">{v.metrics.volatilityPct} %</span><span className="sub muted">Sharpe {v.metrics.sharpe}{v.metrics.cvar95_1mPct != null ? ` · CVaR 1 mois ${v.metrics.cvar95_1mPct} % (limite ${v.metrics.cvarLimitPct} %)` : ""} · covariance {v.metrics.riskModel === "factoriel" ? "factorielle" : "échantillon"}</span></div>
            <div className="kpi"><span className="label">Répartition</span><span className="value">{v.equityPct} / {v.bondPct} / {v.cashPct}</span><span className="sub muted">actions / obligations / liquidités{v.bonds.length ? ` · rdt obligataire ${v.metrics.bondYieldPct} %, duration ${v.metrics.bondDurationYears}` : ""}</span></div>
            <div className="kpi"><span className="label">Depuis publication</span>{m.performance ? <><span className={`value ${signClass(m.performance.returnNetPct)}`}>{fmtPct(m.performance.returnNetPct, 2)}</span><span className="sub muted">net de frais · Composite {fmtPct(m.performance.compositePct, 2)} · BRVM 30 {fmtPct(m.performance.brvm30Pct, 2)} · {m.performance.days} j · perte max. {m.performance.maxDrawdownPct} %</span></> : <span className="value muted">—</span>}</div>
          </div>
          <div className="two-col" style={{ marginTop: 12 }}>
            <div style={{ minWidth: 0 }}>
              <h3>Actions · {v.equityPct} %</h3>
              <div className="table-scroll"><table>
                <thead><tr><th className="left">Valeur</th><th className="left">Secteur</th><th>Poids</th><th>Rdt div.</th><th>Perf. visée</th><th className="left">Justification</th></tr></thead>
                <tbody>{v.lines.map((l) => <tr key={l.symbol}><td><Link to={`/valeur/${l.symbol}`} className="sym">{l.symbol}<small>{l.name}</small></Link></td><td className="left muted">{l.sector}</td><td className="mono"><b>{l.weightPct} %</b></td><td className="mono">{l.dividendYield.toFixed(1)} %</td><td className={`mono ${signClass(l.expectedReturnPct)}`}>{fmtPct(l.expectedReturnPct, 1)}</td><td className="left muted" style={{ whiteSpace: "normal", fontSize: 12, maxWidth: 320 }}>{l.rationale}</td></tr>)}</tbody>
              </table></div>
              {v.bonds.length > 0 && (
                <>
                  <h3 style={{ marginTop: 12 }}>Obligations · {v.bondPct} %</h3>
                  <table>
                    <thead><tr><th className="left">Obligation</th><th className="left">Émetteur</th><th>Poids</th><th>Rdt act.</th><th>Duration</th><th>Échéance</th></tr></thead>
                    <tbody>{v.bonds.map((b) => <tr key={b.code}><td><span className="sym">{b.code}<small>{b.name}</small></span></td><td className="left muted">{b.issuer}{b.taxExempt ? " · exonérée" : ""}</td><td className="mono"><b>{b.weightPct} %</b></td><td className="mono">{b.ytmPct.toFixed(2)} %</td><td className="mono">{b.durationYears.toFixed(1)}</td><td className="mono muted">{b.maturityDate.slice(0, 7)}</td></tr>)}</tbody>
                  </table>
                </>
              )}
            </div>
            <div className="grid" style={{ minWidth: 0, alignContent: "start" }}>
              <div>
                <h3>Lecture du moteur</h3>
                <ul className="clean">{v.summary.map((s, i) => <li key={i}>• {s}</li>)}</ul>
                {v.warnings.length > 0 && <ul className="clean">{v.warnings.map((w, i) => <li key={i} style={{ color: "var(--warn)" }}>⚠ {w}</li>)}</ul>}
              </div>
              {v.stress.length > 0 && (
                <div>
                  <h3>Résistance</h3>
                  <table><tbody>{v.stress.map((s) => <tr key={s.key}><td className="left">{s.label}</td><td className={`mono ${signClass(s.totalPct)}`}>{fmtPct(s.totalPct, 1)}</td></tr>)}</tbody></table>
                </div>
              )}
              {m.drift && (
                <div>
                  <h3>Proposition du moteur{m.proposedAt ? ` · ${fmtDateTime(m.proposedAt)}` : ""}</h3>
                  {m.drift.trades.length === 0 ? <p className="muted" style={{ fontSize: 12 }}>Toutes les lignes de la proposition sont dans les bandes de la version publiée : rien à changer.</p> : (
                    <>
                      <p className="muted" style={{ fontSize: 12 }}>{m.drift.trades.length} ligne(s) hors bande, rotation {m.drift.turnoverPct} %, rendement net {m.drift.returnGapPct > 0 ? "+" : ""}{m.drift.returnGapPct} pt par rapport à la version publiée.</p>
                      <table><tbody>{m.drift.trades.map((t) => <tr key={t.symbol}><td className="left"><span className={`badge ${t.side === "vendre" ? "sell" : "buy"}`}>{t.side}</span> {t.symbol}</td><td className="mono">{t.fromPct} % → {t.toPct} %</td></tr>)}</tbody></table>
                    </>
                  )}
                  {analyst && m.proposal && (
                    <div className="row" style={{ marginTop: 8, gap: 8 }}>
                      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note de publication (facultatif)" style={{ flex: 1 }} />
                      <button className="btn sm primary" disabled={busy} onClick={publish}>Publier la proposition (v{m.version + 1})</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          {plan && (
            <div style={{ marginTop: 14 }}>
              <h3>Plan pour mon portefeuille · {fmtFcfa(plan.total)}</h3>
              <p className="muted" style={{ fontSize: 12 }}>Aujourd'hui : actions {plan.equityPct} %, obligations {plan.bondPct} %, liquidités {plan.cashPct} % · modèle : {plan.target.equityPct} / {plan.target.bondPct} / {plan.target.cashPct}. {plan.verdict}</p>
              {plan.plan.trades.length > 0 && (
                <div className="table-scroll"><table>
                  <thead><tr><th className="left">Valeur</th><th className="left">Opération</th><th>Quantité</th><th>Montant</th><th>Frais</th><th>Poids actuel</th><th>Poids modèle</th><th>Bande</th></tr></thead>
                  <tbody>{plan.plan.trades.map((t) => <tr key={t.symbol}><td><Link to={`/valeur/${t.symbol}`} className="sym">{t.symbol}</Link></td><td className="left"><span className={`badge ${t.side === "vendre" ? "sell" : "buy"}`}>{t.side}</span></td><td className="mono">{t.quantity}</td><td className="mono">{fmtNum(t.amount)}</td><td className="mono muted">{fmtNum(t.cost)}</td><td className="mono">{t.fromPct} %</td><td className="mono">{t.toPct} %</td><td className="mono muted">± {t.bandPct}</td></tr>)}</tbody>
                </table></div>
              )}
              {plan.plan.withinBand.length > 0 && <p className="muted" style={{ fontSize: 12 }}>Dans leur bande : {plan.plan.withinBand.map((x) => `${x.symbol} ${x.currentPct} % (cible ${x.targetPct} %)`).join(" · ")}.</p>}
              {plan.bondSuggestions.length > 0 && <p className="muted" style={{ fontSize: 12 }}>Poche obligataire du modèle : {plan.bondSuggestions.map((b) => `${b.code} ${b.weightPct} % (≈ ${fmtFcfa(b.amount)})`).join(" · ")}.</p>}
              <p className="muted" style={{ fontSize: 11 }}>Prochaine revue le {fmtDate(plan.plan.nextReview)} · les ordres se passent auprès de votre SGI ; le plan ne tient compte que des actions, la poche obligataire est indiquée séparément.</p>
            </div>
          )}
          {detail && detail.series.length > 1 && (
            <div style={{ marginTop: 14 }}>
              <h3>Performance depuis la publication, nette de frais, contre le BRVM Composite</h3>
              <PerformanceChart series={detail.series} height={260} />
              <h3 style={{ marginTop: 12 }}>D'où vient la performance du modèle</h3>
              <AttributionPanel url={`/attribution/models/${detail.key}`} compact />
              {detail.versions.length > 1 && <p className="muted" style={{ fontSize: 12 }}>Versions précédentes : {detail.versions.slice(1).map((x) => `v${x.version} (${fmtDate(x.publishedAt)}${x.performance ? `, ${fmtPct(x.performance.returnNetPct, 1)} net` : ""})`).join(" · ")}.</p>}
            </div>
          )}
        </div>
      )}
      {m && !v && <div className="card"><p className="muted">{m.proposal ? "Ce modèle a une proposition mais n'est pas encore publié." : "Ce modèle n'a pas encore été calculé : le premier calcul se lance deux minutes après le démarrage, ou à la demande."}</p>{analyst && m.proposal && <button className="btn sm primary" disabled={busy} onClick={publish}>Publier la proposition</button>}</div>}
      <p className="disclaimer">Les portefeuilles modèles sont des références de gestion produites par le moteur et relues par l'analyste ; ils ne tiennent pas compte de votre situation personnelle. Les performances sont calculées sur les cours ajustés, nettes des frais d'entrée et de sortie, et ne préjugent pas de l'avenir.</p>
    </div>
  );
}
