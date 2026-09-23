import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMarket } from "../hooks/useMarket";
import { api } from "../lib/api";
import { fmtDate, fmtDateTime, fmtNum } from "../lib/format";
import type { MarketEvent, Signal } from "../lib/types";
import { NewsPanel } from "../components/NewsPanel";

const KIND_LABEL: Record<MarketEvent["kind"], string> = { dividend: "Dividende", agm: "Assemblée", results: "Résultats", market: "Place" };

export function NewsPage() {
  const { signals: live } = useMarket();
  const [history, setHistory] = useState<Signal[]>([]);
  const [events, setEvents] = useState<MarketEvent[]>([]);
  const [kind, setKind] = useState<"all" | MarketEvent["kind"]>("all");
  const [filter, setFilter] = useState<"all" | "bullish" | "bearish">("all");

  useEffect(() => {
    api<Signal[]>("/market/signals?limit=150").then(setHistory).catch(() => {});
    api<MarketEvent[]>("/market/events").then(setEvents).catch(() => {});
  }, []);

  const seen = new Set<number>();
  const all = [...live, ...history].filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true))).filter((s) => filter === "all" || s.kind === filter);
  const upcoming = events.filter((e) => e.date >= Date.now() - 86_400_000 && (kind === "all" || e.kind === kind));

  return (
    <div className="grid">
      <NewsPanel title="Actualité BRVM et presse financière" limit={40} />
    <div className="two-col">
      <div className="card">
        <div className="card-head">
          <div><h2>Signaux Kraken en direct</h2><span className="muted" style={{ fontSize: 12 }}>Détectés sur l'historique de marché et publiés à chaque cotation</span></div>
          <div className="seg">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>Tous</button>
            <button className={filter === "bullish" ? "active up" : ""} onClick={() => setFilter("bullish")}>Haussiers</button>
            <button className={filter === "bearish" ? "active down" : ""} onClick={() => setFilter("bearish")}>Baissiers</button>
          </div>
        </div>
        {all.length === 0 && <p className="muted">Aucun signal pour le moment.</p>}
        {all.map((s) => (
          <div key={s.id} className="signal">
            <span className={`dot ${s.kind}`} />
            <span><Link to={`/valeur/${s.symbol}`} className="sym">{s.symbol}</Link> · {s.message} <span className="muted">à {fmtNum(s.price)}</span></span>
            <span className="spacer" />
            <time>{fmtDateTime(s.ts)}</time>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Calendrier des événements</h2>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} style={{ width: 150 }}>
            <option value="all">Tous</option>
            <option value="dividend">Dividendes</option>
            <option value="results">Résultats</option>
            <option value="agm">Assemblées</option>
            <option value="market">Place</option>
          </select>
        </div>
        <ul className="clean">
          {upcoming.slice(0, 60).map((e) => (
            <li key={e.id}>
              <div className="row" style={{ gap: 8 }}>
                <span className="mono muted" style={{ width: 90 }}>{fmtDate(e.date)}</span>
                <span className={`badge ${e.kind === "dividend" ? "buy" : e.kind === "market" ? "avoid" : "hold"}`}>{KIND_LABEL[e.kind]}</span>
                <span>{e.symbol ? <Link to={`/valeur/${e.symbol}`} className="sym">{e.symbol}</Link> : null} {e.title.replace(/^[^:]+: /, "")}</span>
              </div>
              <div className="muted" style={{ fontSize: 12, paddingLeft: 98 }}>{e.detail}{e.indicative && " (date indicative, à confirmer par avis BRVM)"}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
    </div>
  );
}
