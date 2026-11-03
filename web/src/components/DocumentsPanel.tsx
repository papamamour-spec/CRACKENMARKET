import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api, post } from "../lib/api";
import { fmtDate, fmtDateTime } from "../lib/format";
import type { CompanyDocument, DocumentHistory, DocumentsResponse } from "../lib/types";

export const DOC_KIND_LABEL: Record<string, string> = { rapport_annuel: "Rapport annuel", etats_financiers: "États financiers", resultats: "Résultats", dividende: "Dividende", assemblee: "Assemblée", note_information: "Note d'information", communique: "Communiqué", autre: "Autre" };
const KIND_CLASS: Record<string, string> = { rapport_annuel: "strong-buy", etats_financiers: "buy", resultats: "buy", dividende: "hold", assemblee: "hold", note_information: "reduce", communique: "hold", autre: "avoid" };

/** Documents d'une société (historique par année) ou derniers documents de toutes les sociétés ; collecte et import pour les analystes. */
export function DocumentsPanel({ symbol, limit = 30, title = "Documents des sociétés" }: { symbol?: string; limit?: number; title?: string }) {
  const { user } = useAuth();
  const analyst = user?.role === "analyst" || user?.role === "admin";
  const [history, setHistory] = useState<DocumentHistory | null>(null);
  const [all, setAll] = useState<DocumentsResponse | null>(null);
  const [kind, setKind] = useState("all");
  const [paste, setPaste] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (symbol) api<DocumentHistory>(`/market/documents/history/${symbol}`).then(setHistory).catch(() => {});
    api<DocumentsResponse>(`/market/documents?limit=${limit}${symbol ? `&symbol=${symbol}` : ""}`).then(setAll).catch(() => {});
  };
  useEffect(load, [symbol, limit]);

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await post<{ inserted: number; status: DocumentsResponse["status"] }>("/market/documents/refresh", symbol ? { symbols: [symbol] } : {});
      setMsg(`${r.inserted} document(s) collecté(s)${r.status.lastRun?.failed.length ? ` · sources injoignables : ${r.status.lastRun.failed.join(", ")}` : ""}.`);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const doImport = async () => {
    if (!paste.trim()) return;
    setBusy(true);
    try {
      const r = await post<{ inserted: number; rejected: string[] }>("/market/documents/import", { text: paste });
      setMsg(`${r.inserted} document(s) importé(s)${r.rejected.length ? ` · ${r.rejected.length} ligne(s) rejetée(s)` : ""}.`);
      setPaste("");
      load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const status = all?.status;
  const Row = ({ d, showSymbol }: { d: CompanyDocument; showSymbol?: boolean }) => (
    <div className="signal">
      <span className={`badge ${KIND_CLASS[d.kind] ?? "hold"}`} style={{ flexShrink: 0 }}>{DOC_KIND_LABEL[d.kind] ?? d.kind}</span>
      <span>
        {showSymbol && <Link to={`/valeur/${d.symbol}`} className="sym" style={{ marginRight: 6 }}>{d.symbol}</Link>}
        <a href={d.url} target="_blank" rel="noreferrer">{d.title}</a>
        <span className="muted" style={{ fontSize: 11 }}> · {d.period ?? ""}{d.period ? " · " : ""}{d.published_at ? fmtDate(d.published_at) : "date inconnue"} · {d.source}</span>
      </span>
    </div>
  );

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {symbol && history ? `${history.total} document(s) · ${history.latestAnnualReport ? `dernier rapport annuel ${history.latestAnnualReport.period ?? ""}` : "aucun rapport annuel"} · ${history.latestResults ? `derniers résultats ${history.latestResults.period ?? ""}` : "aucun résultat publié"}` : status ? `${status.documents} document(s) de ${status.companies} société(s) · sources : ${status.sources.map((s) => s.name).join(", ")}` : ""}
            {status?.lastRun ? ` · dernière collecte ${fmtDateTime(status.lastRun.at)}${status.lastRun.failed.length ? ` (injoignables : ${status.lastRun.failed.map((f) => f.split(" (")[0]).join(", ")})` : ""}` : ""}
          </span>
        </div>
        <div className="row">
          {!symbol && all && <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 170 }}><option value="all">Tous types</option>{Object.entries(DOC_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
          {analyst && <button className="btn sm" disabled={busy} onClick={refresh}>Collecter maintenant</button>}
        </div>
      </div>
      {symbol && history && history.years.length > 0 && history.years.map((y) => (
        <details key={y.year} open={y === history.years[0]}>
          <summary style={{ cursor: "pointer", fontWeight: 600, padding: "6px 0" }}>{y.year} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· {y.documents.length} document(s)</span></summary>
          {y.documents.map((d) => <Row key={d.id} d={d} />)}
        </details>
      ))}
      {symbol && history && history.years.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Aucun document collecté pour cette société pour le moment.{analyst ? " Lancez la collecte ou importez une liste." : ""}</p>}
      {!symbol && all && (all.items.filter((d) => kind === "all" || d.kind === kind).map((d) => <Row key={d.id} d={d} showSymbol />))}
      {!symbol && all && all.items.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Aucun document collecté pour le moment.</p>}
      {analyst && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer", fontSize: 13 }}>Importer des documents (une ligne : SYMBOLE ; titre ; lien ; date)</summary>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={4} style={{ width: "100%", marginTop: 6, fontFamily: "inherit" }} placeholder={"SNTS ; Rapport annuel 2025 ; https://… ; 2026-04-30"} />
          <button className="btn sm" style={{ marginTop: 6 }} disabled={busy || !paste.trim()} onClick={doImport}>Importer</button>
        </details>
      )}
      {msg && <p className="muted" style={{ fontSize: 12 }}>{msg}</p>}
    </div>
  );
}
