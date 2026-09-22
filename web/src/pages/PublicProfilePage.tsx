import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api, del, post } from "../lib/api";
import { fmtDate, fmtDateTime, fmtPct, signClass } from "../lib/format";
import type { PublicProfile } from "../lib/types";
import { PerformanceChart } from "../components/PerformanceChart";

export function PublicProfilePage() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const [p, setP] = useState<PublicProfile | null>(null);
  const [error, setError] = useState("");
  const load = () => {
    api<PublicProfile>(`/social/profile/${id}`).then(setP).catch((e) => setError(e.message));
  };
  useEffect(load, [id]);
  if (error) return <div className="card error">{error}</div>;
  if (!p) return <div className="card">Chargement…</div>;
  const toggle = async () => {
    if (p.isFollowed) await del(`/social/follow/${p.userId}`);
    else await post(`/social/follow/${p.userId}`, {});
    load();
  };
  return (
    <div className="grid">
      <div className="card row">
        <div><h1>{p.displayName}</h1><span className="muted">Membre depuis {fmtDate(p.memberSince)} · {p.followers} abonné(s) · {p.points} points</span></div>
        <div className="kpi"><span className="label">Performance totale</span><span className={`value ${signClass(p.totalReturnPct)}`}>{fmtPct(p.totalReturnPct)}</span></div>
        <div className="kpi"><span className="label">vs BRVM Composite (6 mois)</span><span className={`value ${signClass(p.stats.benchmarkReturnPct)}`}>{fmtPct(p.stats.benchmarkReturnPct)}</span></div>
        <div className="kpi"><span className="label">Taux de réussite</span><span className="value">{p.stats.winRate} %</span></div>
        <span className="spacer" />
        {user && user.id !== p.userId && <button className={`btn ${p.isFollowed ? "" : "primary"}`} onClick={toggle}>{p.isFollowed ? "Ne plus suivre" : "Suivre"}</button>}
      </div>
      <div className="two-col">
        <div className="card"><h2>Courbe de performance (%)</h2><PerformanceChart series={p.curve} /></div>
        <div className="grid">
          <div className="card">
            <h3>Répartition</h3>
            <table><tbody>{p.allocation.map((a) => <tr key={a.symbol}><td className="left"><Link to={`/valeur/${a.symbol}`} className="sym">{a.symbol}</Link></td><td className="left muted">{a.sector}</td><td className="mono">{a.weightPct} %</td></tr>)}<tr><td className="left muted">Liquidités</td><td /><td className="mono">{p.cashPct} %</td></tr></tbody></table>
          </div>
          <div className="card">
            <h3>Dernières opérations</h3>
            <ul className="clean">{p.recentTrades.map((t, i) => <li key={i}><span className={t.side === "buy" ? "up" : "down"}>{t.side === "buy" ? "Achat" : "Vente"}</span> <Link to={`/valeur/${t.symbol}`} className="sym">{t.symbol}</Link> {t.resultPct !== null && <span className={signClass(t.resultPct)}>({fmtPct(t.resultPct)})</span>} <span className="muted" style={{ fontSize: 11 }}>{fmtDateTime(t.ts)}</span></li>)}</ul>
          </div>
        </div>
      </div>
    </div>
  );
}
