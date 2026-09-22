import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api, del, post } from "../lib/api";
import { fmtDateTime, fmtPct, signClass } from "../lib/format";
import type { LeaderboardEntry } from "../lib/types";

export function LeaderboardPage() {
  const { user } = useAuth();
  const [period, setPeriod] = useState<"month" | "all">("month");
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);
  const [activity, setActivity] = useState<{ symbol: string; side: "buy" | "sell"; ts: number; userId: number; displayName: string }[]>([]);

  const load = () => {
    api<LeaderboardEntry[]>(`/social/leaderboard?period=${period}`).then(setRows).catch(() => {});
    if (user) api<typeof activity>("/social/activity").then(setActivity).catch(() => {});
  };
  useEffect(load, [period, user]);

  const toggleFollow = async (e: LeaderboardEntry) => {
    if (e.isFollowed) await del(`/social/follow/${e.userId}`);
    else await post(`/social/follow/${e.userId}`, {});
    load();
  };
  const myRank = rows.findIndex((r) => r.userId === user?.id);

  return (
    <div className="two-col">
      <div className="card">
        <div className="card-head">
          <div>
            <h2>Classement des investisseurs</h2>
            <span className="muted" style={{ fontSize: 12 }}>Profils publics · portefeuilles virtuels · {myRank >= 0 ? `vous êtes ${myRank + 1}ᵉ` : "rendez votre profil public pour apparaître"}</span>
          </div>
          <div className="seg">
            <button className={period === "month" ? "active" : ""} onClick={() => setPeriod("month")}>Concours du mois</button>
            <button className={period === "all" ? "active" : ""} onClick={() => setPeriod("all")}>Depuis l'ouverture</button>
          </div>
        </div>
        <table>
          <thead><tr><th className="left">#</th><th className="left">Investisseur</th><th>Perf. 30 j</th><th>Perf. totale</th><th>Lignes</th><th>Ordres</th><th>Points</th><th className="left">Principales lignes</th><th>Abonnés</th><th></th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.userId} style={r.userId === user?.id ? { background: "var(--bg-3)" } : undefined}>
                <td><span className={`rank r${i + 1}`}>{i + 1}</span></td>
                <td className="left"><Link to={`/investisseur/${r.userId}`} className="sym">{r.displayName}<small>{{ investor: "Particulier", sgi: "SGI", institutional: "Institutionnel", analyst: "Analyste" }[r.role] ?? r.role}</small></Link></td>
                <td className={`mono ${signClass(r.monthReturnPct)}`}>{fmtPct(r.monthReturnPct)}</td>
                <td className={`mono ${signClass(r.totalReturnPct)}`}>{fmtPct(r.totalReturnPct)}</td>
                <td className="mono">{r.lines}</td>
                <td className="mono">{r.trades}</td>
                <td className="mono">{r.points}</td>
                <td className="left muted">{r.topHoldings.join(", ") || "—"}</td>
                <td className="mono">{r.followers}</td>
                <td>{r.userId !== user?.id && <button className={`btn sm ${r.isFollowed ? "" : "primary"}`} onClick={() => toggleFollow(r)}>{r.isFollowed ? "Suivi ✓" : "Suivre"}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted">Aucun profil public pour le moment.</p>}
      </div>
      <div className="card">
        <h3>Opérations des investisseurs que je suis</h3>
        {activity.length === 0 && <p className="muted">Suivez des investisseurs pour voir leurs opérations ici et vous en inspirer.</p>}
        <ul className="clean">
          {activity.map((a, i) => (
            <li key={i}><Link to={`/investisseur/${a.userId}`}>{a.displayName}</Link> <span className={a.side === "buy" ? "up" : "down"}>{a.side === "buy" ? "achète" : "vend"}</span> <Link to={`/valeur/${a.symbol}`} className="sym">{a.symbol}</Link> <span className="muted" style={{ fontSize: 11 }}>{fmtDateTime(a.ts)}</span></li>
          ))}
        </ul>
      </div>
    </div>
  );
}
