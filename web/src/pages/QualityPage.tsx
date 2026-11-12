import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api, post } from "../lib/api";
import { fmtDate, fmtDateTime, fmtFcfa, fmtPct, signClass } from "../lib/format";
import type { DailyResponse, QualityFinding, QualityResponse, QualitySeverity } from "../lib/types";

const SEV_CLASS: Record<QualitySeverity, string> = { error: "sell", warning: "reduce", info: "hold" };
const SEV_LABEL: Record<QualitySeverity, string> = { error: "erreur", warning: "avertissement", info: "information" };

/** Contrôle de qualité des données (score, constats par contrôle, changements) et rapport de risque du jour. */
export function QualityPage() {
  const { user } = useAuth();
  const analyst = user?.role === "analyst" || user?.role === "admin";
  const [q, setQ] = useState<QualityResponse | null>(null);
  const [d, setD] = useState<DailyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const load = () => { api<QualityResponse>("/quality").then(setQ).catch(() => {}); api<DailyResponse>("/quality/daily").then(setD).catch(() => {}); };
  useEffect(() => { load(); }, []);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const runChecks = () => run(async () => { const r = await post<QualityResponse>("/quality/run", {}); setQ(r); return `Contrôles passés : score ${r.run?.score}/100, ${r.run?.errors} erreur(s), ${r.run?.warnings} avertissement(s), ${r.run?.changes.added.length} nouveau(x), ${r.run?.changes.resolved.length} résolu(s).`; });
  const runDaily = () => run(async () => { const r = await post<DailyResponse>("/quality/daily/run", {}); setD(r); return `Rapport du jour établi${r.report?.changes.length ? ` : ${r.report.changes.length} changement(s) depuis la veille` : " : rien de notable depuis la veille"}.`; });
  const runR = q?.run ?? null;
  const findings = (runR?.findings ?? []).filter((f) => filter === "all" || f.check === filter);
  const rep = d?.report ?? null;
  const Finding = ({ f }: { f: QualityFinding }) => <li><span className={`badge ${SEV_CLASS[f.severity]}`}>{SEV_LABEL[f.severity]}</span> {f.symbol ? <><Link to={`/valeur/${f.symbol}`} className="sym">{f.symbol}</Link> · </> : null}<span className="muted" style={{ fontSize: 12 }}>{q?.labels[f.check] ?? f.check}</span> — {f.message}</li>;

  return (
    <div className="grid">
      <div className="card">
        <div className="card-head">
          <div><h1>Qualité des données & risque du jour</h1><span className="muted">Dix contrôles passent chaque jour ouvré après la clôture sur tout ce qui nourrit les modèles : cohérence entre bulletin officiel et cours en base, fraîcheur, variations hors limite, dividendes, référentiel, fondamentaux, obligations, collecteurs, modèles. Chaque constat a une sévérité, un score global est calculé et les changements depuis le passage précédent sont conservés. Le rapport du jour reprend la place, votre portefeuille et les modèles, et dit ce qui a changé depuis la veille.</span></div>
          {analyst && <div className="row"><button className="btn sm" disabled={busy} onClick={runChecks}>Passer les contrôles</button><button className="btn sm" disabled={busy} onClick={runDaily}>Établir le rapport du jour</button></div>}
        </div>
        {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
      </div>

      <div className="grid grid-3">
        <div className="card kpi"><span className="label">Score de qualité</span><span className={`value ${runR ? (runR.score >= 80 ? "up" : runR.score >= 60 ? "" : "down") : "muted"}`}>{runR ? `${runR.score} / 100` : "—"}</span><span className="sub muted">{runR ? `${runR.errors} erreur(s) · ${runR.warnings} avertissement(s) · ${runR.infos} information(s) · ${fmtDateTime(runR.ts)}` : "aucun passage encore (3 minutes après le démarrage)"}</span></div>
        <div className="card kpi"><span className="label">Changements depuis le passage précédent</span><span className="value">{runR ? `${runR.changes.added.length} / ${runR.changes.resolved.length}` : "—"}</span><span className="sub muted">nouveaux / résolus{runR?.changes.added.some((f) => f.severity === "error") ? " · de nouvelles erreurs" : ""}</span></div>
        <div className="card kpi"><span className="label">Historique du score</span><span className="value">{q?.history.length ? q.history.map((h) => h.score).slice(-7).join(" · ") : "—"}</span><span className="sub muted">{q?.history.length ? `${q.history.length} passage(s) · 7 derniers` : ""}</span></div>
      </div>

      {rep && (
        <div className="card">
          <div className="card-head"><div><h2>Rapport du jour · {fmtDate(rep.date)}</h2><span className="muted" style={{ fontSize: 12 }}>établi {fmtDateTime(rep.ts)} · cote {rep.market.provider === "live" ? "en direct" : "simulée"}</span></div></div>
          {rep.changes.length > 0 ? <ul className="clean" style={{ marginBottom: 10 }}>{rep.changes.map((c, i) => <li key={i} style={{ color: "var(--warn)" }}>⚠ {c}</li>)}</ul> : <p className="muted" style={{ fontSize: 12 }}>{d?.previous ? "Rien de notable depuis la veille." : "Premier rapport : les changements seront calculés à partir de demain."}</p>}
          <div className="grid grid-3" style={{ gap: 10 }}>
            <div className="kpi"><span className="label">Place</span><span className={`value ${signClass(rep.market.compositeChangePct)}`}>{fmtPct(rep.market.compositeChangePct, 2)}</span><span className="sub muted">BRVM Composite {rep.market.composite.toFixed(2)} · BRVM 30 {fmtPct(rep.market.brvm30ChangePct, 2)} · {rep.market.advancers} hausses, {rep.market.decliners} baisses, {rep.market.unchanged} inchangées</span></div>
            {rep.holdings ? (
              <div className="kpi"><span className="label">Portefeuille détenu · {fmtFcfa(rep.holdings.total)}</span><span className={`value ${rep.holdings.cvar95_1mPct > rep.holdings.cvarLimitPct ? "down" : ""}`}>CVaR {rep.holdings.cvar95_1mPct} %</span><span className="sub muted">limite {rep.holdings.cvarLimitPct} % · volatilité {rep.holdings.volatilityPct} %{rep.holdings.beta != null ? ` · bêta ${rep.holdings.beta}` : ""}{rep.holdings.dayPct != null ? ` · séance ${fmtPct(rep.holdings.dayPct, 2)}` : ""}{rep.holdings.worstStress ? ` · pire scénario ${rep.holdings.worstStress.label.split(" (")[0]} ${fmtPct(rep.holdings.worstStress.totalPct, 1)}` : ""} · {rep.holdings.outsideBand} ligne(s) hors bande{rep.holdings.nextReview ? ` · revue ${fmtDate(rep.holdings.nextReview)}` : ""}</span></div>
            ) : <div className="kpi"><span className="label">Portefeuille détenu</span><span className="value muted">—</span><span className="sub muted">aucune position saisie</span></div>}
            <div className="kpi"><span className="label">Modèles</span><span className="value">{rep.models.filter((m) => m.returnNetPct != null).length} suivis</span><span className="sub muted">{rep.models.map((m) => `${m.label} ${m.returnNetPct != null ? fmtPct(m.returnNetPct, 1) : "—"}${m.driftTrades >= 3 ? " (dérive)" : ""}`).join(" · ")}</span></div>
          </div>
          {rep.holdings && rep.holdings.warnings.length > 0 && <ul className="clean" style={{ marginTop: 8 }}>{rep.holdings.warnings.map((w, i) => <li key={i} className="muted" style={{ fontSize: 12 }}>• {w}</li>)}</ul>}
        </div>
      )}

      {runR && (
        <div className="card">
          <div className="card-head"><div><h2>Constats par contrôle</h2><span className="muted" style={{ fontSize: 12 }}>{runR.findings.length} constat(s) · passage de {runR.durationMs} ms</span></div></div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            <button className={`chip ${filter === "all" ? "sel" : ""}`} onClick={() => setFilter("all")}>Tous ({runR.findings.length})</button>
            {runR.checks.map((c) => <button key={c.check} className={`chip ${filter === c.check ? "sel" : ""} ${c.worst === "error" ? "excl" : ""}`} onClick={() => setFilter(c.check)} title={c.worst ? `pire sévérité : ${SEV_LABEL[c.worst]}` : "aucun constat"}>{c.label} ({c.count})</button>)}
          </div>
          {findings.length === 0 ? <p className="muted">Aucun constat{filter !== "all" ? " pour ce contrôle" : ""} : les données sont cohérentes.</p> : <ul className="clean">{findings.map((f) => <Finding key={f.key} f={f} />)}</ul>}
          {(runR.changes.added.length > 0 || runR.changes.resolved.length > 0) && (
            <div className="two-col" style={{ marginTop: 12 }}>
              <div><h3>Nouveaux depuis le passage précédent</h3>{runR.changes.added.length ? <ul className="clean">{runR.changes.added.map((f) => <Finding key={f.key} f={f} />)}</ul> : <p className="muted" style={{ fontSize: 12 }}>aucun</p>}</div>
              <div><h3>Résolus</h3>{runR.changes.resolved.length ? <ul className="clean">{runR.changes.resolved.map((f) => <li key={f.key} className="muted" style={{ fontSize: 12 }}>✓ {f.symbol ? `${f.symbol} · ` : ""}{f.message}</li>)}</ul> : <p className="muted" style={{ fontSize: 12 }}>aucun</p>}</div>
            </div>
          )}
        </div>
      )}
      <p className="disclaimer">Score = 100 − 10 par erreur − 3 par avertissement − 0,5 par information. Un constat n'est pas une faute des sites sources : il signale ce qu'il faut vérifier avant de faire confiance à un chiffre.</p>
    </div>
  );
}
