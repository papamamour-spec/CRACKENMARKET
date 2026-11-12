import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, del, post } from "../lib/api";
import { fmtDate, fmtDateTime, fmtNum, fmtPct, signClass } from "../lib/format";
import { ACTION_KIND_LABEL, type BocStatus, type CorporateActionView, type CorporateStatus, type DailyStat, type DividendView } from "../lib/types";
import { useAuth } from "../hooks/useAuth";
import { useMarket } from "../hooks/useMarket";

type Tab = "boc" | "dividendes" | "capital";
const STATUS_CLASS: Record<string, string> = { proposé: "hold", approuvé: "buy", payé: "strong-buy" };

/**
 * Données officielles : bulletin de la cote (collecte, import, dernière séance), dividendes réels
 * (saisie, import, lecture automatique) et opérations sur le capital (détection, confirmation).
 * Réservé aux analystes ; l'import du bulletin à l'administrateur.
 */
export function DataPage() {
  const { user } = useAuth();
  const { quotes } = useMarket();
  const admin = user?.role === "admin";
  const [tab, setTab] = useState<Tab>("boc");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // bulletin
  const [bocStatus, setBocStatus] = useState<BocStatus | null>(null);
  const [session, setSession] = useState<{ ts: number | null; items: DailyStat[] }>({ ts: null, items: [] });
  const [bocText, setBocText] = useState("");
  const [bocDate, setBocDate] = useState("");
  // dividendes et capital
  const [corp, setCorp] = useState<{ actions: CorporateActionView[]; dividends: DividendView[]; status: CorporateStatus } | null>(null);
  const [divForm, setDivForm] = useState({ symbol: "SNTS", fiscalYear: String(new Date().getUTCFullYear() - 1), gross: "", net: "", exDate: "", paymentDate: "", agmDate: "", status: "proposé", url: "", note: "" });
  const [divText, setDivText] = useState("");
  const [actForm, setActForm] = useState({ symbol: "SNTS", kind: "split", exDate: "", ratio: "10", note: "" });
  const [filter, setFilter] = useState("");

  const symbols = useMemo(() => [...quotes.keys()].sort(), [quotes]);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try { setMsg(await fn()); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const loadBoc = () => api<{ ts: number | null; items: DailyStat[]; status: BocStatus }>("/market/boc").then((r) => { setSession({ ts: r.ts, items: r.items }); setBocStatus(r.status); }).catch(() => {});
  const loadCorp = () => api<{ actions: CorporateActionView[]; dividends: DividendView[]; status: CorporateStatus }>("/market/corporate").then(setCorp).catch(() => {});
  useEffect(() => { loadBoc(); loadCorp(); }, []);

  const importBoc = () => run(async () => {
    const r = await post<{ session: number; rows: number; applied: number; unrecognized: number; layout: string[]; layoutSource: string }>("/market/boc/import", { text: bocText, date: bocDate || undefined });
    setBocText("");
    await loadBoc();
    return `Séance du ${fmtDate(r.session)} : ${r.rows} ligne(s) lue(s), ${r.applied} appliquée(s)${r.unrecognized ? `, ${r.unrecognized} ignorée(s)` : ""} · colonnes ${r.layoutSource === "header" ? "lues dans l'en-tête" : r.layoutSource === "config" ? "configurées (BOC_COLUMNS)" : "par défaut (volume, veille, ouverture, clôture, variation)"} : ${r.layout.join(", ")}.`;
  });
  const refreshBoc = () => run(async () => {
    const r = await post<{ lastRun: BocStatus["lastRun"] }>("/market/boc/refresh", {});
    await loadBoc();
    return r.lastRun?.ok ? `Collecte réussie : séance du ${r.lastRun.session ? fmtDate(r.lastRun.session) : "?"}, ${r.lastRun.applied} ligne(s) (${r.lastRun.source}).` : `Collecte impossible : ${r.lastRun?.error ?? "erreur inconnue"}.`;
  });
  const saveDividend = () => run(async () => {
    const num = (s: string) => (s.trim() ? Number(s.replace(/[  ]/g, "").replace(",", ".")) : null);
    const d = await post<DividendView>("/market/corporate/dividends", { symbol: divForm.symbol, fiscalYear: Number(divForm.fiscalYear), gross: num(divForm.gross), net: num(divForm.net), exDate: divForm.exDate || null, paymentDate: divForm.paymentDate || null, agmDate: divForm.agmDate || null, status: divForm.status, url: divForm.url || null, note: divForm.note || null });
    await loadCorp();
    return `Dividende ${d.symbol} ${d.fiscalYear} enregistré (${d.netEstimated != null ? `${fmtNum(d.netEstimated)} FCFA net` : "montant à préciser"}). Les séries des modèles sont ajustées.`;
  });
  const importDividends = () => run(async () => {
    const r = await post<{ imported: DividendView[]; rejected: string[] }>("/market/corporate/dividends/import", { text: divText });
    setDivText("");
    await loadCorp();
    return `${r.imported.length} dividende(s) importé(s)${r.rejected.length ? ` · ${r.rejected.length} ligne(s) rejetée(s)` : ""}.`;
  });
  const scanDividends = () => run(async () => {
    const r = await post<{ inserted: number }>("/market/corporate/dividends/scan", {});
    await loadCorp();
    return `${r.inserted} avis de dividende lu(s) dans l'actualité et les documents collectés.`;
  });
  const removeDividend = (id: number) => run(async () => { await del(`/market/corporate/dividends/${id}`); await loadCorp(); return "Dividende supprimé."; });
  const saveAction = () => run(async () => {
    const a = await post<CorporateActionView>("/market/corporate/actions", { symbol: actForm.symbol, kind: actForm.kind, exDate: actForm.exDate, ratio: Number(actForm.ratio), note: actForm.note || null, status: "confirmé" });
    await loadCorp();
    return `${ACTION_KIND_LABEL[a.kind]} ${a.symbol} du ${fmtDate(a.exDate)} enregistré : l'historique servi aux modèles est ajusté.`;
  });
  const detect = () => run(async () => {
    const r = await post<{ inserted: number; suspected: CorporateActionView[] }>("/market/corporate/actions/detect", {});
    await loadCorp();
    return `${r.inserted} fractionnement(s) suspect(s) détecté(s) dans l'historique ; ${r.suspected.length} en attente de confirmation.`;
  });
  const confirmAction = (id: number) => run(async () => { await post(`/market/corporate/actions/${id}/confirm`, {}); await loadCorp(); return "Opération confirmée et appliquée aux séries."; });
  const removeAction = (id: number) => run(async () => { await del(`/market/corporate/actions/${id}`); await loadCorp(); return "Opération supprimée."; });

  const items = session.items.filter((i) => !filter || i.symbol.includes(filter.toUpperCase()));
  const dividends = (corp?.dividends ?? []).filter((d) => !filter || d.symbol.includes(filter.toUpperCase()));
  const actions = (corp?.actions ?? []).filter((a) => !filter || a.symbol.includes(filter.toUpperCase()));
  const field = (label: string, el: JSX.Element) => <div className="field"><label>{label}</label>{el}</div>;

  return (
    <div className="grid">
      <div className="card row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Données officielles</h1>
          <span className="muted">Ce qui nourrit les modèles : bulletin officiel de la cote (transactions, meilleures limites, réservations), dividendes réels et opérations sur le capital. Toute série lue par les prévisions, l'optimiseur et les indicateurs est ajustée de ces opérations.</span>
        </div>
        <div className="row">
          <div className="seg">{(["boc", "dividendes", "capital"] as Tab[]).map((t) => <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t === "boc" ? "Bulletin de la cote" : t === "dividendes" ? "Dividendes" : "Capital"}</button>)}</div>
          <input placeholder="Filtrer par symbole" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 150 }} />
        </div>
      </div>
      <div className="card grid grid-3">
        <div className="kpi"><span className="label">Bulletin de la cote</span><span className="value" style={{ fontSize: 16 }}>{bocStatus ? `${bocStatus.sessions} séance(s)` : "…"}</span><span className="sub muted">{bocStatus?.lastSession ? `dernière : ${fmtDate(bocStatus.lastSession)} (${bocStatus.symbolsLastSession} valeurs)` : "aucune séance"}{bocStatus ? ` · ${bocStatus.sources.length ? `${bocStatus.sources.length} source(s)` : "aucune source (BOC_SOURCES)"}` : ""}</span></div>
        <div className="kpi"><span className="label">Dividendes réels</span><span className="value" style={{ fontSize: 16 }}>{corp ? `${corp.status.dividends} sur ${corp.status.symbolsWithDividends} valeur(s)` : "…"}</span><span className="sub muted">rendement réel, calendrier et ajustement des séries</span></div>
        <div className="kpi"><span className="label">Opérations sur le capital</span><span className="value" style={{ fontSize: 16 }}>{corp ? `${corp.status.actions - corp.status.suspected} confirmée(s)` : "…"}</span><span className={`sub ${corp?.status.suspected ? "down" : "muted"}`}>{corp?.status.suspected ? `${corp.status.suspected} suspectée(s) à confirmer` : "aucune en attente"}</span></div>
      </div>
      {msg && <div className="card" style={{ fontSize: 13 }}>{msg}</div>}

      {tab === "boc" && (
        <div className="two-col" style={{ gridTemplateColumns: "3fr 2fr" }}>
          <div className="card">
            <div className="card-head"><h3>Dernière séance collectée {session.ts ? `· ${fmtDate(session.ts)}` : ""}</h3><span className="muted" style={{ fontSize: 11 }}>{bocStatus?.lastRun ? `${bocStatus.lastRun.ok ? "dernière collecte réussie" : "dernière collecte en échec"} ${fmtDateTime(bocStatus.lastRun.at)}${bocStatus.lastRun.error ? ` : ${bocStatus.lastRun.error}` : ""}` : "aucune collecte automatique"}</span></div>
            {items.length ? (
              <div className="table-scroll">
                <table>
                  <thead><tr><th className="left">Valeur</th><th>Veille</th><th>Clôture</th><th>Var.</th><th>Volume</th><th>Capitaux</th><th>Trans.</th><th>Demande</th><th>Offre</th><th>Déséq.</th><th className="left">État</th></tr></thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.symbol}>
                        <td><Link to={`/valeur/${i.symbol}`} className="sym">{i.symbol}</Link></td>
                        <td className="mono muted">{i.ref != null ? fmtNum(i.ref) : "—"}</td>
                        <td className="mono">{i.close != null ? fmtNum(i.close) : "—"}</td>
                        <td className={`mono ${signClass(i.changePct ?? 0)}`}>{i.changePct != null ? fmtPct(i.changePct, 2) : "—"}</td>
                        <td className="mono">{i.volume != null ? fmtNum(i.volume) : "—"}</td>
                        <td className="mono muted">{i.value != null ? fmtNum(i.value) : "—"}</td>
                        <td className="mono">{i.trades ?? "—"}</td>
                        <td className="mono up">{i.bid != null ? `${fmtNum(i.bid)}${i.bidQty != null ? ` ×${fmtNum(i.bidQty)}` : ""}` : "—"}</td>
                        <td className="mono down">{i.ask != null ? `${fmtNum(i.ask)}${i.askQty != null ? ` ×${fmtNum(i.askQty)}` : ""}` : "—"}</td>
                        <td className={`mono ${i.imbalance != null ? signClass(i.imbalance) : "muted"}`}>{i.imbalance != null ? `${i.imbalance > 0 ? "+" : ""}${Math.round(i.imbalance * 100)} %` : "—"}</td>
                        <td className="left">{i.suspended ? <span className="badge avoid">suspendu</span> : i.reserved ? <span className={`badge ${i.reserved === "up" ? "buy" : "reduce"}`}>réservé {i.reserved === "up" ? "hausse" : "baisse"}</span> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted">Aucune séance en base. Configurez `BOC_SOURCES` (modèles d'URL du bulletin, PDF ou HTML, avec jetons de date) ou importez le texte d'un bulletin ci-contre.</p>}
          </div>
          <div className="card">
            <h3>Importer un bulletin</h3>
            <p className="muted" style={{ fontSize: 12 }}>Collez le tableau des actions (texte du PDF, ou tableau copié avec « ; » ou tabulations). Chaque ligne commence par le symbole BRVM ; la ligne d'en-tête nomme les colonnes (cours veille, ouverture, clôture, variation, volume, valeur, meilleure demande et quantité, meilleure offre et quantité, nombre de transactions). « RH » / « RB » marquent une réservation, « SUSP » une suspension.</p>
            {admin ? (
              <>
                {field("Date de séance (si absente du texte)", <input type="date" value={bocDate} onChange={(e) => setBocDate(e.target.value)} />)}
                <textarea rows={10} value={bocText} onChange={(e) => setBocText(e.target.value)} placeholder={"Symbole Titre Cours veille Ouverture Clôture Variation Volume Valeur Meilleure demande Qté Meilleure offre Qté Nb transactions\nSNTS Sonatel 22450 22500 22600 +0,67 1 250 28 125 000 22550 400 22650 300 7"} style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} />
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn primary sm" disabled={busy || !bocText.trim()} onClick={importBoc}>Importer</button>
                  <button className="btn sm" disabled={busy} onClick={refreshBoc}>Collecter maintenant</button>
                </div>
              </>
            ) : <p className="disclaimer">L'import du bulletin est réservé à l'administrateur.</p>}
          </div>
        </div>
      )}

      {tab === "dividendes" && (
        <div className="two-col" style={{ gridTemplateColumns: "3fr 2fr" }}>
          <div className="card">
            <div className="card-head"><h3>Dividendes renseignés</h3><button className="btn sm" disabled={busy} onClick={scanDividends}>Lire les avis collectés</button></div>
            {dividends.length ? (
              <div className="table-scroll">
                <table>
                  <thead><tr><th className="left">Valeur</th><th>Exercice</th><th>Brut</th><th>Net</th><th>Détachement</th><th>Paiement</th><th>AG</th><th className="left">Statut</th><th className="left">Source</th><th /></tr></thead>
                  <tbody>
                    {dividends.map((d) => (
                      <tr key={d.id}>
                        <td><Link to={`/valeur/${d.symbol}`} className="sym">{d.symbol}<small>{d.name}</small></Link></td>
                        <td className="mono">{d.fiscalYear}</td>
                        <td className="mono">{d.gross != null ? fmtNum(d.gross) : "—"}</td>
                        <td className="mono">{d.net != null ? fmtNum(d.net) : d.netEstimated != null ? <span className="muted">≈ {fmtNum(d.netEstimated)}</span> : "—"}</td>
                        <td className="mono">{d.exDate ? fmtDate(d.exDate) : "—"}</td>
                        <td className="mono">{d.paymentDate ? fmtDate(d.paymentDate) : "—"}</td>
                        <td className="mono">{d.agmDate ? fmtDate(d.agmDate) : "—"}</td>
                        <td className="left"><span className={`badge ${STATUS_CLASS[d.status]}`}>{d.status}</span></td>
                        <td className="left muted" style={{ fontSize: 11 }}>{d.url ? <a href={d.url} target="_blank" rel="noreferrer">{d.source}</a> : d.source}{d.note ? ` · ${d.note}` : ""}</td>
                        <td><button className="btn sm" disabled={busy} onClick={() => removeDividend(d.id)}>Supprimer</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted">Aucun dividende renseigné : les rendements affichés restent ceux du référentiel et aucune série n'est ajustée des détachements.</p>}
          </div>
          <div className="grid">
            <div className="card">
              <h3>Saisir un dividende</h3>
              <div className="grid grid-2" style={{ gap: 8 }}>
                {field("Valeur", <select value={divForm.symbol} onChange={(e) => setDivForm({ ...divForm, symbol: e.target.value })}>{symbols.map((s) => <option key={s}>{s}</option>)}</select>)}
                {field("Exercice", <input type="number" value={divForm.fiscalYear} onChange={(e) => setDivForm({ ...divForm, fiscalYear: e.target.value })} />)}
                {field("Brut par action (FCFA)", <input value={divForm.gross} onChange={(e) => setDivForm({ ...divForm, gross: e.target.value })} placeholder="1 500" />)}
                {field("Net par action (FCFA)", <input value={divForm.net} onChange={(e) => setDivForm({ ...divForm, net: e.target.value })} placeholder="sinon brut − 10 %" />)}
                {field("Détachement", <input type="date" value={divForm.exDate} onChange={(e) => setDivForm({ ...divForm, exDate: e.target.value })} />)}
                {field("Mise en paiement", <input type="date" value={divForm.paymentDate} onChange={(e) => setDivForm({ ...divForm, paymentDate: e.target.value })} />)}
                {field("Assemblée générale", <input type="date" value={divForm.agmDate} onChange={(e) => setDivForm({ ...divForm, agmDate: e.target.value })} />)}
                {field("Statut", <select value={divForm.status} onChange={(e) => setDivForm({ ...divForm, status: e.target.value })}><option value="proposé">proposé</option><option value="approuvé">approuvé</option><option value="payé">payé</option></select>)}
                {field("Source (URL)", <input value={divForm.url} onChange={(e) => setDivForm({ ...divForm, url: e.target.value })} placeholder="https://…" />)}
                {field("Note", <input value={divForm.note} onChange={(e) => setDivForm({ ...divForm, note: e.target.value })} />)}
              </div>
              <button className="btn primary sm" style={{ marginTop: 8 }} disabled={busy || (!divForm.gross && !divForm.net)} onClick={saveDividend}>Enregistrer</button>
            </div>
            <div className="card">
              <h3>Import en bloc</h3>
              <p className="muted" style={{ fontSize: 12 }}>Une ligne par dividende : symbole ; exercice ; brut ; net ; détachement ; paiement ; assemblée ; statut ; source (dates AAAA-MM-JJ ou JJ/MM/AAAA).</p>
              <textarea rows={5} value={divText} onChange={(e) => setDivText(e.target.value)} placeholder="SNTS;2025;1650;1485;2026-05-20;2026-06-05;2026-04-28;payé;brvm" style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} />
              <button className="btn sm" style={{ marginTop: 8 }} disabled={busy || !divText.trim()} onClick={importDividends}>Importer</button>
            </div>
          </div>
        </div>
      )}

      {tab === "capital" && (
        <div className="two-col" style={{ gridTemplateColumns: "3fr 2fr" }}>
          <div className="card">
            <div className="card-head"><h3>Fractionnements, regroupements, attributions</h3><button className="btn sm" disabled={busy} onClick={detect}>Détecter dans l'historique</button></div>
            <p className="muted" style={{ fontSize: 12 }}>La détection repère les ruptures de cours impossibles sans opération (rapport entier ≥ 2, confirmé les séances suivantes) et les propose comme « suspectées » : rien n'ajuste les séries avant confirmation par un analyste.</p>
            {actions.length ? (
              <table>
                <thead><tr><th className="left">Valeur</th><th className="left">Opération</th><th>Date d'effet</th><th className="left">Statut</th><th className="left">Source · note</th><th /></tr></thead>
                <tbody>
                  {actions.map((a) => (
                    <tr key={a.id}>
                      <td><Link to={`/valeur/${a.symbol}`} className="sym">{a.symbol}<small>{a.name}</small></Link></td>
                      <td className="left">{ACTION_KIND_LABEL[a.kind]} {a.kind === "bonus" ? `1 pour ${a.ratio}` : a.kind === "split" ? `1 → ${a.ratio}` : `${a.ratio} → 1`}</td>
                      <td className="mono">{fmtDate(a.exDate)}</td>
                      <td className="left"><span className={`badge ${a.status === "confirmé" ? "buy" : "reduce"}`}>{a.status}</span></td>
                      <td className="left muted" style={{ fontSize: 11 }}>{a.source}{a.note ? ` · ${a.note}` : ""}</td>
                      <td className="row" style={{ gap: 4 }}>
                        {a.status === "suspecté" && <button className="btn primary sm" disabled={busy} onClick={() => confirmAction(a.id)}>Confirmer</button>}
                        <button className="btn sm" disabled={busy} onClick={() => removeAction(a.id)}>{a.status === "suspecté" ? "Rejeter" : "Supprimer"}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted">Aucune opération enregistrée.</p>}
          </div>
          <div className="card">
            <h3>Saisir une opération</h3>
            <div className="grid grid-2" style={{ gap: 8 }}>
              {field("Valeur", <select value={actForm.symbol} onChange={(e) => setActForm({ ...actForm, symbol: e.target.value })}>{symbols.map((s) => <option key={s}>{s}</option>)}</select>)}
              {field("Opération", <select value={actForm.kind} onChange={(e) => setActForm({ ...actForm, kind: e.target.value })}><option value="split">Fractionnement (1 → k)</option><option value="reverse_split">Regroupement (k → 1)</option><option value="bonus">Attribution gratuite (1 pour k)</option></select>)}
              {field("Date d'effet", <input type="date" value={actForm.exDate} onChange={(e) => setActForm({ ...actForm, exDate: e.target.value })} />)}
              {field("Rapport k", <input type="number" value={actForm.ratio} onChange={(e) => setActForm({ ...actForm, ratio: e.target.value })} />)}
              {field("Note (avis officiel, lien)", <input value={actForm.note} onChange={(e) => setActForm({ ...actForm, note: e.target.value })} />)}
            </div>
            <button className="btn primary sm" style={{ marginTop: 8 }} disabled={busy || !actForm.exDate || !(Number(actForm.ratio) > 0)} onClick={saveAction}>Enregistrer</button>
            <p className="disclaimer" style={{ marginTop: 8 }}>Les cours antérieurs à la date d'effet sont divisés par k (fractionnement), multipliés par k (regroupement) ou ramenés à k / (k + 1) (attribution), les volumes à l'inverse. Les cours affichés sur les graphiques restent ceux réellement cotés sauf bascule « Cours ajustés ».</p>
          </div>
        </div>
      )}
    </div>
  );
}
