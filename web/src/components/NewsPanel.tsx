import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api, post } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import type { NewsResponse } from "../lib/types";

export function sentimentLabel(s: number): { text: string; cls: string } {
  if (s >= 0.2) return { text: "favorable", cls: "up" };
  if (s <= -0.2) return { text: "défavorable", cls: "down" };
  return { text: "neutre", cls: "muted" };
}

/** Veille d'actualité : articles BRVM et presse financière, sentiment agrégé, ajout manuel pour les analystes. */
export function NewsPanel({ symbol, limit = 30, title = "Actualité" }: { symbol?: string; limit?: number; title?: string }) {
  const { user } = useAuth();
  const [data, setData] = useState<NewsResponse | null>(null);
  const [form, setForm] = useState({ source: "BRVM", title: "", url: "", summary: "" });
  const [msg, setMsg] = useState("");
  const analyst = user?.role === "analyst" || user?.role === "admin";
  const load = () => {
    api<NewsResponse>(`/market/news?limit=${limit}${symbol ? `&symbol=${symbol}` : ""}`).then(setData).catch(() => {});
  };
  useEffect(load, [symbol, limit]);
  const add = async () => {
    setMsg("");
    try {
      await post("/market/news", { ...form, summary: form.summary || undefined });
      setForm({ source: "BRVM", title: "", url: "", summary: "" });
      setMsg("Article ajouté et pris en compte par le conseiller.");
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const refresh = async () => {
    setMsg("Collecte en cours…");
    try {
      const r = await post<{ inserted: number; status: NewsResponse["status"] }>("/market/news/refresh", {});
      setMsg(`${r.inserted} article(s) collecté(s)${r.status.lastRun?.failed.length ? ` · sources injoignables : ${r.status.lastRun.failed.join(", ")}` : ""}`);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  if (!data) return <div className="card"><h3>{title}</h3><p className="muted">Chargement…</p></div>;
  const agg = symbol ? data.symbolSentiment : data.market;
  const lbl = sentimentLabel(agg?.score ?? 0);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {agg && agg.count > 0 ? <>Sentiment 14 jours : <b className={lbl.cls}>{lbl.text}</b> ({agg.score > 0 ? "+" : ""}{agg.score}, {agg.count} article{agg.count > 1 ? "s" : ""}) · pris en compte par le conseiller</> : "Aucune actualité récente rattachée"}
          </span>
        </div>
        {analyst && <button className="btn sm" onClick={refresh}>Collecter maintenant</button>}
      </div>
      {data.items.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Sources suivies : {data.status.sources.join(", ")}.{data.status.lastRun?.failed.length ? ` Injoignables depuis ce serveur : ${data.status.lastRun.failed.join(", ")}.` : ""}</p>}
      {data.items.map((n) => {
        const l = sentimentLabel(n.sentiment);
        return (
          <div key={n.id} className="signal">
            <span className={`dot ${n.sentiment >= 0.2 ? "bullish" : n.sentiment <= -0.2 ? "bearish" : "neutral"}`} title={`Sentiment ${l.text}`} />
            <span>
              <a href={n.url} target="_blank" rel="noreferrer">{n.title}</a>
              <span className="muted" style={{ fontSize: 11 }}> · {n.source} · {fmtDateTime(n.published_at)}</span>
              {!symbol && n.symbols.length > 0 && <span style={{ fontSize: 11 }}> · {n.symbols.map((s) => <Link key={s} to={`/valeur/${s}`} className="chip">{s}</Link>)}</span>}
              {n.summary && <div className="muted" style={{ fontSize: 12 }}>{n.summary}</div>}
            </span>
          </div>
        );
      })}
      {analyst && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer", fontSize: 13 }}>Ajouter un article ou un avis BRVM (analyste)</summary>
          <div className="grid grid-2" style={{ marginTop: 8 }}>
            <div className="field"><label>Source</label><input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} /></div>
            <div className="field"><label>Lien</label><input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Titre</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label>Résumé (facultatif)</label><input value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></div>
          </div>
          <button className="btn primary" onClick={add}>Ajouter</button>
        </details>
      )}
      {msg && <p className="muted" style={{ fontSize: 12 }}>{msg}</p>}
    </div>
  );
}
