import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { QuoteTable } from "../components/QuoteTable";
import { ScoreBar } from "../components/ScoreBar";
import { useMarket } from "../hooks/useMarket";
import { api } from "../lib/api";
import { fmtNum, fmtPct, signClass } from "../lib/format";
import type { ScreenerRow } from "../lib/types";

export function MarketPage() {
  const { quotes } = useMarket();
  const [tab, setTab] = useState<"cote" | "screener">("cote");
  const [sector, setSector] = useState("Tous");
  const [search, setSearch] = useState("");
  const [screener, setScreener] = useState<ScreenerRow[]>([]);
  const [sortKey, setSortKey] = useState<keyof ScreenerRow>("composite");

  useEffect(() => {
    const load = () => api<ScreenerRow[]>("/market/screener").then(setScreener).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  const all = Array.from(quotes.values());
  const sectors = ["Tous", ...Array.from(new Set(all.map((q) => q.sector))).sort()];
  const rows = useMemo(
    () => all.filter((q) => (sector === "Tous" || q.sector === sector) && (q.symbol + q.name).toLowerCase().includes(search.toLowerCase())),
    [all, sector, search],
  );
  const scr = useMemo(
    () => screener.filter((r) => (sector === "Tous" || r.sector === sector) && (r.symbol + r.name).toLowerCase().includes(search.toLowerCase())).sort((a, b) => (b[sortKey] as number) - (a[sortKey] as number)),
    [screener, sector, search, sortKey],
  );

  return (
    <div className="card">
      <div className="card-head">
        <div className="tabs" style={{ margin: 0, border: 0 }}>
          <button className={tab === "cote" ? "active" : ""} onClick={() => setTab("cote")}>Cote complète ({rows.length})</button>
          <button className={tab === "screener" ? "active" : ""} onClick={() => setTab("screener")}>Screener technique</button>
        </div>
        <div className="row">
          <input placeholder="Rechercher…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 180 }} />
          <select value={sector} onChange={(e) => setSector(e.target.value)} style={{ width: 200 }}>{sectors.map((s) => <option key={s}>{s}</option>)}</select>
        </div>
      </div>
      {tab === "cote" ? (
        <QuoteTable rows={rows} />
      ) : (
        <table>
          <thead>
            <tr>
              <th className="left">Valeur</th>
              <th>Cours</th>
              <th>Var.</th>
              {(["composite", "trend", "momentum", "rsi", "volatility", "perf1m", "perf1y", "dividendYield"] as const).map((k) => (
                <th key={k} onClick={() => setSortKey(k)} style={{ color: sortKey === k ? "var(--text)" : undefined }}>
                  {{ composite: "Score", trend: "Tendance", momentum: "Momentum", rsi: "RSI", volatility: "Volat.", perf1m: "1 mois", perf1y: "1 an", dividendYield: "Rdt div." }[k]}
                </th>
              ))}
              <th className="left">Signaux</th>
            </tr>
          </thead>
          <tbody>
            {scr.map((r) => (
              <tr key={r.symbol}>
                <td><Link to={`/valeur/${r.symbol}`} className="sym">{r.symbol}<small>{r.name}</small></Link></td>
                <td className="mono">{fmtNum(r.price)}</td>
                <td className={`mono ${signClass(r.changePct)}`}>{fmtPct(r.changePct)}</td>
                <td style={{ minWidth: 110 }}><div className="gauge"><ScoreBar value={r.composite} /><span className="mono" style={{ width: 30 }}>{r.composite}</span></div></td>
                <td className={`mono ${signClass(r.trend)}`}>{r.trend}</td>
                <td className={`mono ${signClass(r.momentum)}`}>{r.momentum}</td>
                <td className={`mono ${r.rsi > 70 ? "down" : r.rsi < 30 ? "up" : ""}`}>{r.rsi}</td>
                <td className="mono">{r.volatility} %</td>
                <td className={`mono ${signClass(r.perf1m)}`}>{fmtPct(r.perf1m, 1)}</td>
                <td className={`mono ${signClass(r.perf1y)}`}>{fmtPct(r.perf1y, 1)}</td>
                <td className="mono">{r.dividendYield.toFixed(1)} %</td>
                <td className="left muted" style={{ whiteSpace: "normal", maxWidth: 320, fontSize: 12 }}>{r.signals.slice(0, 2).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
