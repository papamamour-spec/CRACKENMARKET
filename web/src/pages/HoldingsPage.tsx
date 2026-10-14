import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ActionBadge, ScoreBar } from "../components/ScoreBar";
import { SkeletonCard } from "../components/Skeleton";
import { useMarket } from "../hooks/useMarket";
import { api, del, post, put } from "../lib/api";
import { fmtDateTime, fmtFcfa, fmtNum, fmtPct, signClass } from "../lib/format";
import type { HeldPortfolio, HeldPosition, PortfolioAnalysis } from "../lib/types";

const ACTION_CLASS: Record<string, string> = { renforcer: "buy", conserver: "hold", alléger: "reduce", vendre: "sell", initier: "strong-buy", diversifier: "hold", liquidités: "hold" };
const PERIODS = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y"] as const;
const PERIOD_LABEL: Record<string, string> = { "1D": "Veille", "1W": "1 sem.", "1M": "1 mois", "3M": "3 mois", "6M": "6 mois", YTD: "Année", "1Y": "1 an" };

interface Row { symbol: string; quantity: string; avgPrice: string }

/** Saisie du portefeuille réellement détenu (chez une SGI) et analyse Kraken ligne par ligne. */
export function HoldingsPage() {
  const { quotes } = useMarket();
  const nav = useNavigate();
  const symbols = Array.from(quotes.keys()).sort();
  const [saved, setSaved] = useState<HeldPortfolio | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [cash, setCash] = useState("0");
  const [label, setLabel] = useState("");
  const [importText, setImportText] = useState("");
  const [analysis, setAnalysis] = useState<PortfolioAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState(true);

  const fromSaved = (p: HeldPortfolio) => {
    setSaved(p);
    setRows(p.positions.map((x) => ({ symbol: x.symbol, quantity: String(x.quantity), avgPrice: x.avgPrice != null ? String(x.avgPrice) : "" })));
    setCash(String(p.cash));
    setLabel(p.label ?? "");
  };
  useEffect(() => {
    api<HeldPortfolio>("/holdings").then((p) => {
      fromSaved(p);
      if (p.positions.length) {
        setEditing(false);
        api<PortfolioAnalysis>("/holdings/analysis").then(setAnalysis).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  const positions = (): HeldPosition[] => rows.filter((r) => r.symbol && Number(r.quantity) > 0).map((r) => ({ symbol: r.symbol, quantity: Number(r.quantity), avgPrice: r.avgPrice ? Number(r.avgPrice.replace(",", ".")) : null, acquiredAt: null, note: null }));
  const addRow = () => setRows([...rows, { symbol: symbols.find((s) => !rows.some((r) => r.symbol === s)) ?? "SNTS", quantity: "", avgPrice: "" }]);
  const run = async (save: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      if (save) {
        const p = await put<HeldPortfolio>("/holdings", { label: label || null, cash: Number(cash) || 0, positions: positions() });
        fromSaved(p);
        setAnalysis(await api<PortfolioAnalysis>("/holdings/analysis"));
        setMsg({ ok: true, text: `Portefeuille enregistré (${p.positions.length} ligne(s)) et analysé.` });
        setEditing(false);
      } else {
        setAnalysis(await post<PortfolioAnalysis>("/holdings/analysis", { cash: Number(cash) || 0, positions: positions() }));
        setMsg({ ok: true, text: "Analyse de l'aperçu (non enregistré)." });
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const doImport = async () => {
    if (!importText.trim()) return;
    setBusy(true);
    try {
      const r = await post<HeldPortfolio & { imported: number; rejected: string[] }>("/holdings/import", { text: importText, replace: false });
      fromSaved(r);
      setImportText("");
      setMsg({ ok: true, text: `${r.imported} ligne(s) importée(s)${r.rejected.length ? ` · non reconnues : ${r.rejected.join(" | ")}` : ""}.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const copyVirtual = async () => {
    setBusy(true);
    try {
      fromSaved(await post<HeldPortfolio>("/holdings/import-virtual", {}));
      setMsg({ ok: true, text: "Portefeuille virtuel copié : vérifiez puis enregistrez." });
    } finally {
      setBusy(false);
    }
  };
  const removeLine = async (symbol: string) => {
    setRows(rows.filter((r) => r.symbol !== symbol));
    if (saved?.positions.some((p) => p.symbol === symbol)) fromSaved(await del<HeldPortfolio>(`/holdings/line/${symbol}`));
  };
  const toAdvisory = () => {
    try { localStorage.setItem("cm.advisory.holdings", JSON.stringify(positions().map((p) => ({ symbol: p.symbol, quantity: p.quantity, avgPrice: p.avgPrice ?? undefined })))); } catch { /* stockage indisponible */ }
    nav("/conseil");
  };

  const a = analysis;
  return (
    <div className="grid">
      <div className="card row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Analyser mon portefeuille</h1>
          <span className="muted">Saisissez les titres que vous détenez réellement (relevé de votre SGI) : le moteur Kraken valorise, mesure le risque, prévoit et recommande ligne par ligne quoi conserver, renforcer, alléger ou vendre.</span>
        </div>
        <div className="row">
          {!editing && <button className="btn" onClick={() => setEditing(true)}>Modifier le portefeuille</button>}
          {a && a.lines.length > 0 && <button className="btn primary" onClick={toAdvisory}>Demander un conseil avec ce portefeuille</button>}
        </div>
      </div>

      {editing && (
        <div className="card">
          <div className="card-head">
            <div><h2>Mon portefeuille</h2><span className="muted" style={{ fontSize: 12 }}>{saved?.updatedAt ? `Enregistré le ${fmtDateTime(saved.updatedAt)}` : "Aucun portefeuille enregistré"} · le prix de revient unitaire (PRU) est facultatif mais permet le calcul des plus ou moins-values</span></div>
            <div className="row"><button className="btn sm" disabled={busy} onClick={copyVirtual}>Copier mon portefeuille virtuel</button></div>
          </div>
          <div className="grid grid-3" style={{ gap: 10 }}>
            <div className="field"><label>Intitulé (facultatif)</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ex. Compte-titres Matha n° 001234" /></div>
            <div className="field"><label>Liquidités disponibles (FCFA)</label><input type="number" value={cash} onChange={(e) => setCash(e.target.value)} /></div>
          </div>
          <table>
            <thead><tr><th className="left">Valeur</th><th>Quantité</th><th>PRU (FCFA, facultatif)</th><th>Cours</th><th>Valorisation</th><th></th></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const q = quotes.get(r.symbol);
                return (
                  <tr key={i}>
                    <td className="left"><select value={r.symbol} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, symbol: e.target.value } : x)))} style={{ width: 240 }}>{symbols.map((s) => <option key={s} value={s}>{s} · {quotes.get(s)?.name}</option>)}</select></td>
                    <td><input type="number" min={1} value={r.quantity} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, quantity: e.target.value } : x)))} style={{ width: 110, textAlign: "right" }} placeholder="0" /></td>
                    <td><input type="number" min={0} value={r.avgPrice} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, avgPrice: e.target.value } : x)))} style={{ width: 130, textAlign: "right" }} placeholder="—" /></td>
                    <td className="mono muted">{q ? fmtNum(q.price) : "—"}</td>
                    <td className="mono">{q && Number(r.quantity) > 0 ? fmtNum(q.price * Number(r.quantity)) : "—"}</td>
                    <td><button className="btn sm" onClick={() => removeLine(r.symbol)}>✕</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={addRow}>+ Ajouter une ligne</button>
            <span className="spacer" />
            <button className="btn" disabled={busy || !rows.length} onClick={() => run(false)}>Analyser sans enregistrer</button>
            <button className="btn primary" disabled={busy} onClick={() => run(true)}>Enregistrer et analyser</button>
          </div>
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: "pointer", fontSize: 13 }}>Importer un relevé (copier-coller : une ligne par valeur, « SYMBOLE ; quantité ; PRU »)</summary>
            <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={5} style={{ width: "100%", marginTop: 6, fontFamily: "inherit" }} placeholder={"SNTS ; 100 ; 21500\nOrange Côte d'Ivoire ; 40 ; 13000\nSGBC 25"} />
            <button className="btn sm" style={{ marginTop: 6 }} disabled={busy} onClick={doImport}>Importer ces lignes</button>
          </details>
          {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
        </div>
      )}
      {!editing && msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}

      {busy && !a && <SkeletonCard lines={8} />}
      {a && a.lines.length > 0 && (
        <>
          <div className="card grid grid-3">
            <div className="kpi"><span className="label">Valeur totale</span><span className="value">{fmtFcfa(a.totals.total)}</span><span className="sub muted">{fmtFcfa(a.totals.invested)} en titres · {fmtFcfa(a.totals.cash)} de liquidités ({a.totals.cashPct} %)</span></div>
            <div className="kpi"><span className="label">Plus ou moins-value latente</span><span className={`value ${signClass(a.totals.pnl ?? 0)}`}>{a.totals.pnl != null ? `${a.totals.pnl > 0 ? "+" : ""}${fmtFcfa(a.totals.pnl)}` : "—"}</span><span className="sub muted">{a.totals.pnlPct != null ? `${fmtPct(a.totals.pnlPct, 1)} sur un coût de ${fmtFcfa(a.totals.cost ?? 0)}` : "renseignez les prix de revient pour la calculer"}</span></div>
            <div className="kpi"><span className="label">Dividendes attendus</span><span className="value up">{fmtFcfa(a.totals.annualDividendIncome)}</span><span className="sub muted">par an · {a.totals.dividendYieldPct} % des titres</span></div>
            <div className="kpi"><span className="label">Santé du portefeuille</span><div className="gauge"><ScoreBar value={a.diagnostic.healthScore} positive /><span className="mono" style={{ width: 26 }}>{a.diagnostic.healthScore}</span></div><span className="sub muted">diversification {a.diagnostic.diversificationScore}/100 · risque {a.diagnostic.riskScore}/100 · profil {a.profileStyle}</span></div>
            <div className="kpi"><span className="label">Prévision Kraken</span><span className={`value ${signClass(a.forecast.expected3MPct)}`}>{fmtPct(a.forecast.expected3MPct, 1)} à 3 mois</span><span className="sub muted">{fmtPct(a.forecast.expected1MPct, 1)} à 1 mois · probabilité de hausse {Math.round(a.forecast.probUp3M * 100)} % · ≈ {a.forecast.amount3M > 0 ? "+" : ""}{fmtFcfa(a.forecast.amount3M)}</span></div>
            <div className="kpi"><span className="label">Risque</span><span className="value">{a.risk.volatilityPct} % <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>vol. annuelle</span></span><span className="sub muted">{a.risk.beta != null ? `bêta ${a.risk.beta} · ` : ""}perte max. 1 an {a.risk.maxDrawdown1yPct} % · VaR 95 % 1 mois {fmtFcfa(a.risk.var95_1m)} · {a.risk.concentrationLabel}</span></div>
          </div>

          <div className="two-col">
            <div className="card">
              <h2>Ce que Kraken recommande</h2>
              <ul className="clean" style={{ marginBottom: 10 }}>{a.summary.map((s, i) => <li key={i}>• {s}</li>)}</ul>
              {a.warnings.length > 0 && <ul className="clean" style={{ marginBottom: 10 }}>{a.warnings.map((w, i) => <li key={i} style={{ color: "var(--warn)" }}>⚠ {w}</li>)}</ul>}
              <h3>Actions proposées, par priorité</h3>
              {a.actions.length === 0 && <p className="muted">Aucune action nécessaire : portefeuille en ligne avec votre profil.</p>}
              <ol className="actions">
                {a.actions.map((x, i) => (
                  <li key={i}><span className={`badge ${ACTION_CLASS[x.kind] ?? "hold"}`}>{x.kind}</span> <b>{x.title}</b><div className="muted" style={{ fontSize: 12 }}>{x.detail}</div></li>
                ))}
              </ol>
              <p className="disclaimer">Aide à la décision produite à partir de l'historique de marché, de l'actualité et de votre profil ; les ordres sont passés auprès de votre SGI. Les prévisions sont probabilistes.</p>
            </div>
            <div className="grid">
              <div className="card">
                <h3>Performance vs BRVM Composite</h3>
                <table>
                  <thead><tr><th className="left">Période</th><th>Portefeuille</th><th>Indice</th><th>Écart</th></tr></thead>
                  <tbody>
                    {PERIODS.map((p) => {
                      const pp = a.performance.portfolioPct[p];
                      const ip = a.performance.indexPct[p];
                      return <tr key={p}><td className="left">{PERIOD_LABEL[p]}</td><td className={`mono ${pp != null ? signClass(pp) : ""}`}>{pp != null ? fmtPct(pp, 1) : "—"}</td><td className={`mono ${ip != null ? signClass(ip) : ""}`}>{ip != null ? fmtPct(ip, 1) : "—"}</td><td className={`mono ${pp != null && ip != null ? signClass(pp - ip) : ""}`}>{pp != null && ip != null ? fmtPct(pp - ip, 1) : "—"}</td></tr>;
                    })}
                  </tbody>
                </table>
                <p className="muted" style={{ fontSize: 11 }}>Performance des titres pondérée par leur valeur actuelle (hors mouvements passés).</p>
              </div>
              <div className="card">
                <h3>Répartition sectorielle</h3>
                <table><tbody>{a.diagnostic.sectorExposure.map((s) => <tr key={s.sector}><td className="left">{s.sector}</td><td style={{ width: 120 }}><ScoreBar value={s.weightPct} positive /></td><td className="mono">{s.weightPct} %</td></tr>)}</tbody></table>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Ligne par ligne</h2>
            <div className="table-scroll">
            <table>
              <thead><tr><th className="left">Valeur</th><th>Qté</th><th>PRU</th><th>Cours</th><th>Valeur</th><th>+/- value</th><th>Poids</th><th>Rdt div.</th><th>1 mois</th><th className="left">Avis Kraken</th><th>Prévision 1 m / 3 m</th><th className="left">Action proposée</th></tr></thead>
              <tbody>
                {a.lines.map((l) => (
                  <tr key={l.symbol}>
                    <td><Link to={`/valeur/${l.symbol}`} className="sym">{l.symbol}<small>{l.name} · {l.sector}</small></Link></td>
                    <td className="mono">{l.quantity}</td>
                    <td className="mono muted">{l.avgPrice != null ? fmtNum(l.avgPrice) : "—"}</td>
                    <td className="mono">{fmtNum(l.price)}</td>
                    <td className="mono">{fmtNum(l.value)}</td>
                    <td className={`mono ${l.pnl != null ? signClass(l.pnl) : "muted"}`}>{l.pnl != null ? <>{l.pnl > 0 ? "+" : ""}{fmtNum(l.pnl)}<br /><small>{fmtPct(l.pnlPct ?? 0, 1)}</small></> : "—"}</td>
                    <td className={`mono ${l.weightPct > 25 ? "down" : ""}`}>{l.weightPct} %</td>
                    <td className="mono">{l.dividendYield.toFixed(1)} %</td>
                    <td className={`mono ${l.perf?.["1M"] != null ? signClass(l.perf["1M"]!) : ""}`}>{l.perf?.["1M"] != null ? fmtPct(l.perf["1M"]!, 1) : "—"}</td>
                    <td className="left"><ActionBadge action={l.recommendation.action} /><div className="muted" style={{ fontSize: 11, whiteSpace: "normal", maxWidth: 220 }}>{l.recommendation.rationale[0]} · objectif {fmtNum(l.recommendation.targetPrice)}, stop {fmtNum(l.recommendation.stopLoss)}</div></td>
                    <td className="mono">{l.forecast ? <><span className={signClass(l.forecast.expected1M)}>{fmtPct(l.forecast.expected1M, 1)}</span> / <span className={signClass(l.forecast.expected3M)}>{fmtPct(l.forecast.expected3M, 1)}</span><br /><small className="muted">hausse {Math.round(l.forecast.probUp3M * 100)} %</small></> : "—"}</td>
                    <td className="left"><span className={`badge ${ACTION_CLASS[l.action.kind]}`}>{l.action.kind}{l.action.quantity > 0 ? ` ${l.action.quantity}` : ""}</span><div className="muted" style={{ fontSize: 11, whiteSpace: "normal", maxWidth: 260 }}>{l.action.reasons.join(" · ")}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>

          {a.target && (
            <div className="card">
              <div className="card-head">
                <div><h2>Portefeuille cible optimisé</h2><span className="muted" style={{ fontSize: 12 }}>Allocation moyenne-variance sous contraintes de votre profil, à partir des prévisions, des dividendes et de la covariance réelle des valeurs ; les titres déjà détenus bénéficient d'une prime (frais et fiscalité d'un aller-retour évités) et les mouvements inférieurs à 3 % du portefeuille sont ignorés.</span></div>
              </div>
              <div className="grid grid-3" style={{ gap: 10 }}>
                <div className="kpi"><span className="label">Aujourd'hui</span><span className="value">{fmtPct(a.target.currentExpectedAnnualReturnPct, 1)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>/ an</span></span><span className="sub muted">volatilité {a.risk.volatilityPct} % · Sharpe {a.target.currentSharpe}</span></div>
                <div className="kpi"><span className="label">Cible</span><span className="value up">{fmtPct(a.target.expectedAnnualReturnPct, 1)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>/ an</span></span><span className="sub muted">volatilité {a.target.volatilityPct} % · Sharpe {a.target.sharpe}</span></div>
                <div className="kpi"><span className="label">Transactions</span><span className="value">{a.target.trades.length}</span><span className="sub muted">{a.target.trades.filter((t) => t.side === "vendre").length} vente(s), {a.target.trades.filter((t) => t.side === "acheter").length} achat(s)</span></div>
              </div>
              <div className="table-scroll"><table style={{ marginTop: 10 }}>
                <thead><tr><th className="left">Valeur</th><th className="left">Opération</th><th>Quantité</th><th>Montant</th><th>Poids actuel</th><th>Poids cible</th></tr></thead>
                <tbody>
                  {a.target.trades.map((t) => (
                    <tr key={t.symbol}><td><Link to={`/valeur/${t.symbol}`} className="sym">{t.symbol}<small>{t.name}</small></Link></td><td className="left"><span className={`badge ${t.side === "vendre" ? "sell" : "buy"}`}>{t.side}</span></td><td className="mono">{t.quantity}</td><td className="mono">{fmtNum(t.amount)}</td><td className="mono">{t.fromPct} %</td><td className="mono">{t.toPct} %</td></tr>
                  ))}
                </tbody>
              </table></div>
              <p className="muted" style={{ fontSize: 11 }}>Rapprochez-vous de la cible progressivement, en commençant par les ventes recommandées ; tenez compte des frais de courtage et de la liquidité des titres BRVM.</p>
            </div>
          )}
        </>
      )}
      {a && a.lines.length === 0 && <div className="card"><p className="muted">{a.summary[0]}</p></div>}
    </div>
  );
}
