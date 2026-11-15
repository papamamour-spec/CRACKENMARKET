import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PerformanceChart } from "../components/PerformanceChart";
import { useAuth } from "../hooks/useAuth";
import { api, post } from "../lib/api";
import { fmtDate, fmtDateTime, fmtFcfa, fmtNum, fmtPct, signClass } from "../lib/format";
import type { BacktestReport, ShortTermPortfolio, ShortTermResponse, SimStats } from "../lib/types";

/** Moteur court terme : modèle secondaire (méta-étiquetage), candidats du jour (Kelly fractionnaire), portefeuille à triple barrière. */
export function ShortTermPage() {
  const { user } = useAuth();
  const analyst = user?.role === "analyst" || user?.role === "admin";
  const [data, setData] = useState<ShortTermResponse | null>(null);
  const [capital, setCapital] = useState("5000000");
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<ShortTermPortfolio | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [bt, setBt] = useState<BacktestReport | null>(null);
  const [btVariant, setBtVariant] = useState<"complete" | "sansProtection">("complete");

  const cap = Number(capital.replace(/[  ]/g, "")) || 0;
  const load = () => api<ShortTermResponse>(`/shortterm?capital=${cap > 0 ? cap : 10_000_000}`).then((r) => { setData(r); if (selected == null && r.portfolios[0]) setSelected(r.portfolios[0].id); }).catch(() => {});
  const loadDetail = (id: number) => api<ShortTermPortfolio>(`/shortterm/${id}`).then(setDetail).catch(() => setDetail(null));
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [cap]);
  useEffect(() => { if (selected != null) loadDetail(selected); else setDetail(null); }, [selected]);
  const loadBt = () => api<BacktestReport>("/shortterm/backtest").then(setBt).catch(() => setBt(null));
  useEffect(() => { loadBt(); }, [data?.status.latestBacktest?.id]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const train = () => run(async () => {
    const r = await post<{ started: boolean }>("/shortterm/train", {});
    await load();
    return r.started ? "Entraînement lancé en tâche de fond (quelques minutes) : chaque date du passé est prévue avec son seul historique, puis l'issue de la triple barrière est relevée." : "Un entraînement est déjà en cours.";
  });
  const review = () => run(async () => {
    const r = await post<{ reviewed: number; closed: number; opened: number }>("/shortterm/review", {});
    await load();
    if (selected != null) await loadDetail(selected);
    return `${r.reviewed} portefeuille(s) revu(s) · ${r.closed} position(s) clôturée(s) (barrière ou protection) · ${r.opened} ouverte(s) par rotation.`;
  });
  const backtest = () => run(async () => {
    const r = await post<{ started: boolean }>("/shortterm/backtest", {});
    await load();
    return r.started ? "Mesure complète lancée en tâche de fond : modèle secondaire entraîné sur la première partie de la fenêtre, puis stratégie entière simulée jour par jour sur la suite, avec et sans protection, contre l'indice." : "Une mesure est déjà en cours ou la fenêtre est trop courte.";
  });
  const publish = () => run(async () => {
    const p = await post<ShortTermPortfolio>("/shortterm/publish", { capital: cap });
    await load();
    setSelected(p.id);
    return `Panier publié : ${p.positions.length} ligne(s) au cours du jour, ${fmtFcfa(p.entryCost)} de frais d'entrée, ${fmtFcfa(p.cash)} en liquidités. Les barrières seront revues après chaque clôture.`;
  });
  const close = (positionId: number | null) => run(async () => {
    if (selected == null) return "";
    const p = await post<ShortTermPortfolio>(`/shortterm/${selected}/close`, { positionId });
    setDetail(p);
    await load();
    return positionId == null ? "Portefeuille clôturé au dernier cours." : "Position clôturée au dernier cours.";
  });

  const st = data?.status ?? null;
  const m = st?.model ?? null;
  const cands = data?.candidates.items ?? [];
  const basket = cands.filter((c) => c.selected);
  const shown = showAll ? cands : basket;

  return (
    <div className="grid">
      <div className="card">
        <div className="card-head">
          <div><h1>Court terme</h1><span className="muted">Le modèle primaire (ensemble de prévisions et signaux événementiels) dit où le rendement attendu est positif ; le modèle secondaire apprend, sur l'historique en marche avant, la probabilité que ce signal réussisse dans le contexte du moment (méta-étiquetage). Chaque position est dimensionnée au quart de Kelly et reçoit dès l'entrée un objectif, un seuil et une échéance (triple barrière). Horizon : un à trois mois. Aucun levier.</span></div>
          <div className="row">
            {analyst && <button className="btn sm" disabled={busy || !!st?.training} onClick={train}>{st?.training ? `Entraînement ${st.training.done}/${st.training.total}…` : m ? "Réentraîner le modèle" : "Entraîner le modèle"}</button>}
            {analyst && <button className="btn sm" disabled={busy || !!st?.backtesting} onClick={backtest}>{st?.backtesting ? `Mesure (${st.backtesting.phase}) ${st.backtesting.done}/${st.backtesting.total}…` : "Mesurer le moteur complet"}</button>}
            <button className="btn sm" disabled={busy} onClick={review}>Revoir les barrières</button>
          </div>
        </div>
        {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
        {m ? (
          <div className="grid grid-4" style={{ gap: 10 }}>
            <div className="kpi"><span className="label">Modèle secondaire</span><span className="value" style={{ fontSize: 16 }}>{m.stats.n} positions étiquetées</span><span className="sub muted">entraîné le {fmtDateTime(m.createdAt)} · {m.config.sessions} séances, pas {m.config.step} · gagnantes nettes de frais : {Math.round(m.stats.baseRate * 100)} %</span></div>
            <div className="kpi"><span className="label">Pouvoir de tri (test)</span><span className={`value ${(m.stats.auc ?? 0.5) > 0.55 ? "up" : "muted"}`}>{m.stats.auc != null ? `AUC ${m.stats.auc.toFixed(2)}` : "—"}</span><span className="sub muted">{m.stats.accuracy != null ? `précision ${Math.round(m.stats.accuracy * 100)} % contre ${Math.round((m.stats.baselineAccuracy ?? 0) * 100)} % sans modèle` : "test insuffisant"} · {m.stats.testN} obs. de test</span></div>
            <div className="kpi"><span className="label">Fiabilité (Brier)</span><span className={`value ${m.stats.brier != null && m.stats.baselineBrier != null && m.stats.brier <= m.stats.baselineBrier ? "up" : "down"}`}>{m.stats.brier ?? "—"}</span><span className="sub muted">référence {m.stats.baselineBrier ?? "—"} · plus bas est mieux</span></div>
            <div className="kpi"><span className="label">Sélection ≥ {Math.round(m.config.minProb * 100)} %</span>{m.stats.selectedReturnPct != null ? <><span className={`value ${signClass(m.stats.selectedReturnPct)}`}>{fmtPct(m.stats.selectedReturnPct, 2)}</span><span className="sub muted">rendement moyen net par position retenue, contre {fmtPct(m.stats.allReturnPct ?? 0, 2)} pour toutes · {Math.round((m.stats.selectedShare ?? 0) * 100)} % retenues</span></> : <span className="value muted">—</span>}</div>
          </div>
        ) : <p className="muted" style={{ fontSize: 12 }}>{st?.training ? `Entraînement en cours : ${st.training.done}/${st.training.total} dates.` : "Aucun modèle secondaire encore entraîné : les candidats utilisent la probabilité de hausse du primaire. L'entraînement se lance automatiquement trois minutes après le démarrage, puis chaque semaine."}</p>}
        {st && data && (
          <div className="grid grid-4" style={{ gap: 10, marginTop: 10 }}>
            <div className="kpi"><span className="label">Régime de marché</span><span className={`value ${st.regime.key === "haussier" ? "up" : st.regime.key === "neutre" ? "" : "down"}`} style={{ fontSize: 18 }}>{st.regime.label} <span className="muted" style={{ fontSize: 13 }}>× {st.regime.multiplier}</span></span><span className="sub muted">{st.regime.reasons.join(" · ")}{st.regime.volRatio != null ? ` · volatilité ×${st.regime.volRatio}` : ""}{st.regime.drawdownPct != null ? ` · repli ${st.regime.drawdownPct} %` : ""}</span></div>
            <div className="kpi"><span className="label">Protection à la publication</span><span className="value" style={{ fontSize: 18 }}>{Math.round(data.candidates.protection.exposure * 100)} % <span className="muted" style={{ fontSize: 13 }}>investissables</span></span><span className="sub muted">plancher cliquet {Math.round(data.candidates.protection.floorPct * 100)} % du plus haut · coussin × {data.candidates.protection.multiplier} = {Math.round(data.candidates.protection.rawExposure * 100)} % avant régime · jamais de levier</span></div>
            <div className="kpi"><span className="label">Dernière mesure complète</span>{st.latestBacktest ? <><span className={`value ${signClass(st.latestBacktest.complete.totalReturnPct)}`}>{fmtPct(st.latestBacktest.complete.totalReturnPct, 1)}</span><span className="sub muted">hors échantillon, {st.latestBacktest.test.sessions} séances · indice {fmtPct(st.latestBacktest.index.totalReturnPct, 1)} · sans protection {fmtPct(st.latestBacktest.sansProtection.totalReturnPct, 1)}</span></> : <span className="value muted">—</span>}</div>
            <div className="kpi"><span className="label">Perte maximale (mesure)</span>{st.latestBacktest ? <><span className="value down">{st.latestBacktest.complete.maxDrawdownPct} %</span><span className="sub muted">indice {st.latestBacktest.index.maxDrawdownPct} % · sans protection {st.latestBacktest.sansProtection.maxDrawdownPct} % · exposition moyenne {st.latestBacktest.complete.avgExposurePct} %</span></> : <span className="value muted">—</span>}</div>
          </div>
        )}
        {m && (
          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>Poids appris et fiabilité par tranche</summary>
            <div className="two-col" style={{ marginTop: 8 }}>
              <table>
                <thead><tr><th className="left">Variable de contexte</th><th>Poids (standardisé)</th></tr></thead>
                <tbody>{[...m.stats.coefficients].sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta)).map((c) => <tr key={c.key}><td className="left">{c.label}</td><td className={`mono ${signClass(c.beta)}`}>{c.beta > 0 ? "+" : ""}{c.beta.toFixed(3)}</td></tr>)}</tbody>
              </table>
              <table>
                <thead><tr><th className="left">Probabilité annoncée</th><th>Obs.</th><th>Annoncée</th><th>Observée</th></tr></thead>
                <tbody>{m.stats.calibration.map((b) => <tr key={b.from}><td className="left">{Math.round(b.from * 100)}–{Math.round(b.to * 100)} %</td><td className="mono">{b.n}</td><td className="mono muted">{b.predicted != null ? `${Math.round(b.predicted * 100)} %` : "—"}</td><td className="mono">{b.observed != null ? `${Math.round(b.observed * 100)} %` : "—"}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div><h2>Panier du jour</h2><span className="muted" style={{ fontSize: 12 }}>{basket.length} ligne(s) retenue(s) sur {cands.length} valeurs · liquidités {data?.candidates.cashPct ?? 100} % · objectif 1,5 σ, seuil 1 σ, échéance 2 mois · poids = quart de Kelly borné à {m?.config.maxWeightPct ?? 20} % et par la liquidité{data?.candidates.at ? ` · calculé ${fmtDateTime(data.candidates.at)}` : ""}</span></div>
          <div className="row" style={{ gap: 8 }}>
            <label className="muted" style={{ fontSize: 12 }}>Capital <input value={capital} onChange={(e) => setCapital(e.target.value)} style={{ width: 120 }} /> FCFA</label>
            <button className="btn sm" onClick={() => setShowAll(!showAll)}>{showAll ? "Panier seul" : "Toutes les valeurs"}</button>
            <button className="btn sm primary" disabled={busy || !basket.length || !(cap > 0)} onClick={publish}>Publier le panier</button>
          </div>
        </div>
        {shown.length ? (
          <div className="table-scroll"><table>
            <thead><tr><th className="left">Valeur</th><th>Cours</th><th>Attendu 1 mois</th><th>P(succès)</th><th>Kelly</th><th>Poids</th><th>Objectif</th><th>Seuil</th><th>Échéance</th><th>Liquidité max.</th></tr></thead>
            <tbody>{shown.map((c) => (
              <tr key={c.symbol} className={c.selected ? "sel" : ""}>
                <td><Link to={`/valeur/${c.symbol}`} className="sym">{c.symbol}<small>{c.name}</small></Link></td>
                <td className="mono">{fmtNum(c.price)}</td>
                <td className={`mono ${signClass(c.expectedPct)}`}>{fmtPct(c.expectedPct, 1)}</td>
                <td className={`mono ${c.prob >= (m?.config.minProb ?? 0.55) ? "up" : "muted"}`}><b>{Math.round(c.prob * 100)} %</b><span className="muted"> · hausse {Math.round(c.probUp * 100)} %</span></td>
                <td className="mono muted">{c.kelly ? `${Math.round(c.kelly * 100)} %` : "—"}</td>
                <td className="mono"><b>{c.weightPct ? `${c.weightPct} %` : "—"}</b></td>
                <td className="mono up">{fmtNum(c.targetPrice)} <span className="muted">+{(c.barriers.profit * 100).toFixed(1)} %</span></td>
                <td className="mono down">{fmtNum(c.stopPrice)} <span className="muted">−{(c.barriers.stop * 100).toFixed(1)} %</span></td>
                <td className="mono muted">{fmtDate(c.deadlineTs)}</td>
                <td className="mono muted">{c.liquidityCapPct >= 100 ? "—" : `${c.liquidityCapPct} %`}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <p className="muted">Aucune valeur ne dépasse le seuil de probabilité aujourd'hui : le moteur reste en liquidités. C'est une décision, pas un défaut.</p>}
      </div>

      {bt && (() => {
        const v = bt.variants[btVariant];
        const rows: [string, SimStats | null][] = [["Moteur complet (protection + régime)", bt.variants.complete.stats], ["Sans protection", bt.variants.sansProtection.stats]];
        return (
          <div className="card">
            <div className="card-head">
              <div><h2>Mesure complète hors échantillon</h2><span className="muted" style={{ fontSize: 12 }}>Modèle secondaire entraîné du {fmtDate(bt.train.from)} au {fmtDate(bt.train.to)} ({bt.train.stats.n} positions étiquetées, AUC {bt.train.stats.auc ?? "—"}) ; stratégie simulée jour par jour du {fmtDate(bt.test.from)} au {fmtDate(bt.test.to)} ({bt.test.sessions} séances, {bt.test.rotations} rotations), nette de frais, sans rien lire au-delà de chaque date. Calculée le {fmtDateTime(bt.createdAt)}.</span></div>
            </div>
            <ul className="clean" style={{ fontSize: 12, marginBottom: 10 }}>{bt.verdict.map((x, i) => <li key={i}>• {x}</li>)}</ul>
            <div className="row" style={{ marginBottom: 8 }}><span className="muted" style={{ fontSize: 12 }}>Courbe :</span><div className="seg"><button className={btVariant === "complete" ? "active" : ""} onClick={() => setBtVariant("complete")}>Moteur complet</button><button className={btVariant === "sansProtection" ? "active" : ""} onClick={() => setBtVariant("sansProtection")}>Sans protection</button></div></div>
            <div className="two-col" style={{ gridTemplateColumns: "1.2fr 1fr" }}>
              <div style={{ minWidth: 0 }}>
                <PerformanceChart series={v.series} height={240} />
                <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>Exposition moyenne {v.stats.avgExposurePct} % · en liquidités {Math.round(v.stats.cashShare * 100)} % des séances · sorties : {Object.entries(v.stats.exits).map(([k, n]) => `${k} ${n}`).join(", ") || "aucune"}.</p>
              </div>
              <div className="table-scroll"><table>
                <thead><tr><th className="left">Variante</th><th>Total</th><th>Annualisé</th><th>Perte max.</th><th>Vol.</th><th>Sharpe</th><th>Positions</th><th>Gagnantes</th><th>Rdt / position</th><th>Frais</th></tr></thead>
                <tbody>
                  {rows.map(([label, st2]) => st2 && <tr key={label}><td className="left">{label}</td><td className={`mono ${signClass(st2.totalReturnPct)}`}><b>{fmtPct(st2.totalReturnPct, 1)}</b></td><td className="mono">{st2.annualizedPct != null ? fmtPct(st2.annualizedPct, 1) : "—"}</td><td className="mono down">{st2.maxDrawdownPct} %</td><td className="mono">{st2.volatilityPct ?? "—"}</td><td className="mono">{st2.sharpe ?? "—"}</td><td className="mono">{st2.trades}</td><td className="mono">{st2.winRate != null ? `${Math.round(st2.winRate * 100)} %` : "—"}</td><td className={`mono ${signClass(st2.avgTradeReturnPct ?? 0)}`}>{st2.avgTradeReturnPct != null ? fmtPct(st2.avgTradeReturnPct, 2) : "—"}</td><td className="mono muted">{st2.feesPct} %</td></tr>)}
                  <tr><td className="left">BRVM Composite</td><td className={`mono ${signClass(bt.index.totalReturnPct)}`}><b>{fmtPct(bt.index.totalReturnPct, 1)}</b></td><td className="mono muted">—</td><td className="mono down">{bt.index.maxDrawdownPct} %</td><td className="mono muted" colSpan={6}>référence sans frais</td></tr>
                </tbody>
              </table></div>
            </div>
          </div>
        );
      })()}

      {data && data.portfolios.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div><h2>Portefeuilles court terme</h2><span className="muted" style={{ fontSize: 12 }}>Positions figées au cours du jour, frais déduits ; la première barrière touchée clôture la ligne au cours de clôture.</span></div>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>{data.portfolios.map((p) => <button key={p.id} className={`btn sm ${p.id === selected ? "primary" : ""}`} onClick={() => setSelected(p.id)}>{fmtDate(p.startTs)} · {p.status === "actif" ? `${p.stats.open} ouverte(s)` : "clos"} · <span className={signClass(p.stats.returnNetPct)}>{fmtPct(p.stats.returnNetPct, 1)}</span></button>)}</div>
          </div>
          {detail && (
            <>
              <div className="grid grid-4" style={{ gap: 10 }}>
                <div className="kpi"><span className="label">Depuis le {fmtDate(detail.startTs)}</span><span className={`value ${signClass(detail.stats.returnNetPct)}`}>{fmtPct(detail.stats.returnNetPct, 2)}</span><span className="sub muted">net de frais · brut {fmtPct(detail.stats.returnPct, 2)} · {detail.stats.days} j · {detail.stats.sessions} séance(s)</span></div>
                <div className="kpi"><span className="label">Écart à l'indice</span><span className={`value ${signClass(detail.stats.alphaPct)}`}>{fmtPct(detail.stats.alphaPct, 2)}</span><span className="sub muted">BRVM Composite {fmtPct(detail.stats.compositePct, 2)} · perte max. {detail.stats.maxDrawdownPct} %</span></div>
                <div className="kpi"><span className="label">Positions</span><span className="value">{detail.stats.open} <span className="muted" style={{ fontSize: 14 }}>ouverte(s)</span></span><span className="sub muted">{detail.stats.closed} clôturée(s) : {detail.stats.wins} gagnante(s), {detail.stats.losses} perdante(s)</span></div>
                <div className="kpi"><span className="label">Valeur</span><span className="value" style={{ fontSize: 16 }}>{fmtFcfa(detail.stats.valueNet)}</span><span className="sub muted">capital {fmtFcfa(detail.capital)} · liquidités {fmtFcfa(detail.cash)} · frais d'entrée {fmtFcfa(detail.entryCost)}</span></div>
              </div>
              {detail.protection && (
                <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>Protection : plus haut {fmtFcfa(detail.protection.state.peak)} · plancher {fmtFcfa(detail.protection.state.floor)} ({Math.round(detail.protection.floorPct * 100)} %) · coussin {fmtFcfa(detail.protection.state.cushion)} · exposition autorisée {Math.round(detail.protection.exposure * 100)} % (régime {detail.protection.regime.label.toLowerCase()} × {detail.protection.regime.multiplier}) · investi {detail.stats.valueNet > 0 ? Math.round(((detail.stats.value - detail.cash) / detail.stats.value) * 100) : 0} %. Au-dessus du plafond, les lignes les moins probables sont soldées à la revue ; en dessous, les candidats du jour sont ajoutés.</p>
              )}
              {detail.series.length > 1 && <div style={{ marginTop: 10 }}><PerformanceChart series={detail.series} height={220} /></div>}
              <div className="table-scroll" style={{ marginTop: 10 }}><table>
                <thead><tr><th className="left">Valeur</th><th>Entrée</th><th>Qté</th><th>Poids</th><th>P(succès)</th><th>Cours</th><th>Rdt</th><th>Objectif</th><th>Seuil</th><th>Échéance</th><th className="left">Statut</th>{detail.status === "actif" && <th />}</tr></thead>
                <tbody>{detail.positions.map((p) => (
                  <tr key={p.id} className={p.exitTs != null ? "muted" : ""}>
                    <td><Link to={`/valeur/${p.symbol}`} className="sym">{p.symbol}<small>{p.name}</small></Link></td>
                    <td className="mono">{fmtNum(p.entryPrice)}<span className="muted"> · {fmtDate(p.entryTs)}</span></td>
                    <td className="mono">{p.quantity}</td>
                    <td className="mono">{p.weightPct} %</td>
                    <td className="mono">{Math.round(p.prob * 100)} %</td>
                    <td className="mono">{fmtNum(p.price)}</td>
                    <td className={`mono ${signClass(p.returnPct)}`}><b>{fmtPct(p.returnPct, 1)}</b></td>
                    <td className="mono up">{fmtNum(p.targetPrice)}{p.exitTs == null && <span className="muted"> ({fmtPct(p.toTargetPct, 1)})</span>}</td>
                    <td className="mono down">{fmtNum(p.stopPrice)}{p.exitTs == null && <span className="muted"> ({fmtPct(p.toStopPct, 1)})</span>}</td>
                    <td className="mono muted">{fmtDate(p.deadlineTs)}{p.exitTs == null ? ` · ${p.daysLeft} j` : ""}</td>
                    <td className="left">{p.exitTs != null ? <span className={`badge ${p.returnPct > 0 ? "buy" : "sell"}`}>{p.exitReason} le {fmtDate(p.exitTs)} à {fmtNum(p.exitPrice ?? 0)}</span> : <span className="badge hold">ouverte</span>}</td>
                    {detail.status === "actif" && <td>{p.exitTs == null && <button className="btn sm" disabled={busy} onClick={() => close(p.id)}>Clôturer</button>}</td>}
                  </tr>
                ))}</tbody>
              </table></div>
              {detail.status === "actif" && <div className="row" style={{ marginTop: 8 }}><button className="btn sm" disabled={busy} onClick={() => close(null)}>Clôturer tout le portefeuille au dernier cours</button></div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
