import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api, post } from "../lib/api";
import { fmtDate, fmtDateTime } from "../lib/format";
import { RADAR_KIND_LABEL, type RadarKind, type RadarResponse } from "../lib/types";
import { SkeletonCard } from "../components/Skeleton";

const KIND_CLASS: Record<RadarKind, string> = { introduction: "strong-buy", emission_obligataire: "buy", offre_publique: "hold", dividende: "buy", resultats: "hold", assemblee: "hold", suspension: "sell", nouvelle_obligation: "buy", augmentation_capital: "reduce", calendrier: "avoid" };

/** Radar de la place : introductions, émissions, offres publiques, dividendes, résultats, suspensions, échéances. */
export function RadarPage() {
  const { user } = useAuth();
  const analyst = user?.role === "analyst" || user?.role === "admin";
  const [data, setData] = useState<RadarResponse | null>(null);
  const [kind, setKind] = useState<"all" | RadarKind>("all");
  const [busy, setBusy] = useState(false);
  const load = () => api<RadarResponse>(`/market/radar?limit=200${kind !== "all" ? `&kind=${kind}` : ""}`).then(setData).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [kind]);
  const scan = async () => { setBusy(true); try { await post("/market/radar/scan", {}); await load(); } finally { setBusy(false); } };
  const fresh = Date.now() - 48 * 3600_000;
  const items = data?.items ?? [];
  const upcoming = items.filter((e) => e.date > Date.now());
  const past = items.filter((e) => e.date <= Date.now());
  return (
    <div className="grid">
      <div className="card row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Radar de la place</h1>
          <span className="muted">Tout ce qui bouge sur la BRVM : introductions en bourse, émissions obligataires, offres publiques, dividendes, résultats, assemblées, suspensions, nouvelles obligations cotées et échéances à venir, détectés dans l'actualité, les documents collectés et la cote.</span>
        </div>
        <div className="row">
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} style={{ width: 220 }}><option value="all">Tous les événements</option>{(Object.keys(RADAR_KIND_LABEL) as RadarKind[]).map((k) => <option key={k} value={k}>{RADAR_KIND_LABEL[k]}</option>)}</select>
          {analyst && <button className="btn sm" disabled={busy} onClick={scan}>Balayer maintenant</button>}
        </div>
      </div>
      {!data && <SkeletonCard lines={8} />}
      {data && (
        <>
          <div className="card grid grid-3">
            <div className="kpi"><span className="label">Nouveaux (48 h)</span><span className="value">{data.status.recent48h}</span><span className="sub muted">{data.status.lastScan ? `dernier balayage ${fmtDateTime(data.status.lastScan.at)}` : "balayage en attente"}</span></div>
            <div className="kpi"><span className="label">À venir (30 jours)</span><span className="value">{upcoming.length}</span><span className="sub muted">dividendes, assemblées, publications attendues</span></div>
            <div className="kpi"><span className="label">Par type</span><span className="value" style={{ fontSize: 13 }}>{data.status.byKind.map((k) => `${RADAR_KIND_LABEL[k.kind]} ${k.n}`).join(" · ") || "—"}</span></div>
          </div>
          <div className="two-col">
            <div className="card">
              <h2>Événements</h2>
              {past.length === 0 && <p className="muted">Aucun événement détecté pour le moment{analyst ? " : lancez un balayage ou la collecte des actualités et documents." : "."}</p>}
              {past.map((e) => (
                <div key={e.id} className="signal">
                  <span className={`badge ${KIND_CLASS[e.kind]}`} style={{ flexShrink: 0 }}>{RADAR_KIND_LABEL[e.kind]}</span>
                  <span>
                    {e.symbol && <Link to={`/valeur/${e.symbol}`} className="sym" style={{ marginRight: 6 }}>{e.symbol}</Link>}
                    {e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.title}</a> : e.title}
                    {e.created_at > fresh && <span className="chip sel" style={{ marginLeft: 6 }}>nouveau</span>}
                    {e.detail && <div className="muted" style={{ fontSize: 12 }}>{e.detail}</div>}
                  </span>
                  <span className="spacer" />
                  <time>{fmtDate(e.date)} · {e.source}</time>
                </div>
              ))}
            </div>
            <div className="card">
              <h2>À venir</h2>
              {upcoming.length === 0 && <p className="muted">Rien d'annoncé dans les 30 prochains jours.</p>}
              {upcoming.sort((a, b) => a.date - b.date).map((e) => (
                <div key={e.id} className="signal">
                  <time style={{ minWidth: 86 }}>{fmtDate(e.date)}</time>
                  <span>{e.symbol && <Link to={`/valeur/${e.symbol}`} className="sym" style={{ marginRight: 6 }}>{e.symbol}</Link>}{e.title}{e.detail && <div className="muted" style={{ fontSize: 12 }}>{e.detail}</div>}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
