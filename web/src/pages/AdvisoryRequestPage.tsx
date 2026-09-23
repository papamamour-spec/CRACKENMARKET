import { useEffect, useState } from "react";
import { AdvisoryReportView } from "../components/AdvisoryReportView";
import { useAuth } from "../hooks/useAuth";
import { useMarket } from "../hooks/useMarket";
import { api, post } from "../lib/api";
import { fmtDateTime, fmtFcfa } from "../lib/format";
import { ADVISORY_STATUS_LABEL, type AdvisoryReport, type AdvisoryView } from "../lib/types";

interface Holding {
  symbol: string;
  quantity: number;
  avgPrice?: number;
}

/** Guichet de conseil : un particulier décrit son placement, une SGI le fait pour l'un de ses clients. */
export function AdvisoryRequestPage() {
  const { user } = useAuth();
  const { quotes, notifications } = useMarket();
  const isSgi = user?.role === "sgi";
  const [sectors, setSectors] = useState<string[]>([]);
  const [form, setForm] = useState({ capital: 5_000_000, objective: "balanced", horizonMonths: 36, riskTolerance: 3, preferredSectors: [] as string[], constraints: "", clientLabel: "" });
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [newHolding, setNewHolding] = useState<{ symbol: string; quantity: number }>({ symbol: "SNTS", quantity: 100 });
  const [preview, setPreview] = useState<AdvisoryReport | null>(null);
  const [requests, setRequests] = useState<AdvisoryView[]>([]);
  const [open, setOpen] = useState<AdvisoryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => {
    api<AdvisoryView[]>("/advisory/requests").then(setRequests).catch(() => {});
  };
  useEffect(() => {
    api<{ sectors: string[] }>("/market/sectors").then((r) => setSectors(r.sectors)).catch(() => {});
  }, []);
  useEffect(load, [notifications.length]);

  const body = () => ({ ...form, holdings, clientLabel: isSgi ? form.clientLabel : undefined });
  const doPreview = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setPreview(await post<AdvisoryReport>("/advisory/preview", body()));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const v = await post<AdvisoryView>("/advisory/requests", body());
      setMsg({ ok: true, text: `Demande n° ${v.id} enregistrée. La proposition est disponible ci-dessous ; un analyste la relira.` });
      setPreview(null);
      setOpen(v);
      load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const toggleSector = (s: string) => setForm({ ...form, preferredSectors: form.preferredSectors.includes(s) ? form.preferredSectors.filter((x) => x !== s) : [...form.preferredSectors, s].slice(0, 5) });
  const symbols = Array.from(quotes.keys()).sort();

  return (
    <div className="grid">
      <div className="card row">
        <div>
          <h1>{isSgi ? "Demande de placement pour un client" : "Demander un conseil de placement"}</h1>
          <span className="muted">
            {isSgi
              ? "Décrivez le mandat de votre client : le moteur Kraken produit une allocation motivée et chiffrée, relue par un analyste, que vous pouvez présenter et exécuter."
              : "Indiquez le capital, l'objectif et l'horizon : vous recevez une proposition d'allocation motivée et chiffrée, relue par un analyste. L'exécution se fait ensuite via votre SGI."}
          </span>
        </div>
      </div>
      <div className="two-col">
        <div className="card">
          <h2>Votre placement</h2>
          {isSgi && <div className="field"><label>Client ou portefeuille concerné</label><input value={form.clientLabel} onChange={(e) => setForm({ ...form, clientLabel: e.target.value })} placeholder="Ex. M. Diop – compte 001234, Fonds retraite X…" /></div>}
          <div className="grid grid-2">
            <div className="field"><label>Capital à placer (FCFA)</label><input type="number" value={form.capital} onChange={(e) => setForm({ ...form, capital: Number(e.target.value) })} /></div>
            <div className="field"><label>Horizon : {form.horizonMonths} mois</label><div className="range"><span className="muted">3</span><input type="range" min={3} max={120} step={3} value={form.horizonMonths} onChange={(e) => setForm({ ...form, horizonMonths: Number(e.target.value) })} /><span className="muted">120</span></div></div>
            <div className="field">
              <label>Objectif</label>
              <select value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })}>
                <option value="income">Revenus réguliers (dividendes)</option>
                <option value="balanced">Équilibre revenus / croissance</option>
                <option value="growth">Croissance du capital</option>
                <option value="speculative">Plus-values rapides</option>
              </select>
            </div>
            <div className="field">
              <label>Tolérance au risque</label>
              <div className="seg" style={{ display: "flex" }}>{[1, 2, 3, 4, 5].map((v) => <button key={v} style={{ flex: 1 }} className={form.riskTolerance === v ? "active" : ""} onClick={() => setForm({ ...form, riskTolerance: v })}>{["Très prudent", "Prudent", "Modéré", "Dynamique", "Offensif"][v - 1]}</button>)}</div>
            </div>
          </div>
          <div className="field">
            <label>Secteurs privilégiés (facultatif, 5 max.)</label>
            {sectors.map((s) => <span key={s} className={`chip ${form.preferredSectors.includes(s) ? "sel" : ""}`} style={{ cursor: "pointer" }} onClick={() => toggleSector(s)}>{s}</span>)}
          </div>
          <div className="field"><label>Contraintes particulières (facultatif)</label><input value={form.constraints} onChange={(e) => setForm({ ...form, constraints: e.target.value })} placeholder="Ex. exclure les valeurs bancaires, conserver 2 M FCFA disponibles à 6 mois…" /></div>
          <div className="field">
            <label>Portefeuille déjà détenu (facultatif)</label>
            <div className="row" style={{ gap: 6 }}>
              <select value={newHolding.symbol} onChange={(e) => setNewHolding({ ...newHolding, symbol: e.target.value })} style={{ width: 120 }}>{symbols.map((s) => <option key={s}>{s}</option>)}</select>
              <input type="number" style={{ width: 110 }} value={newHolding.quantity} onChange={(e) => setNewHolding({ ...newHolding, quantity: Number(e.target.value) })} placeholder="Quantité" />
              <button className="btn sm" onClick={() => newHolding.quantity > 0 && setHoldings([...holdings.filter((h) => h.symbol !== newHolding.symbol), { ...newHolding }])}>Ajouter</button>
            </div>
            {holdings.length > 0 && <p style={{ margin: "6px 0 0" }}>{holdings.map((h) => <span key={h.symbol} className="chip">{h.symbol} × {h.quantity} <span style={{ cursor: "pointer" }} onClick={() => setHoldings(holdings.filter((x) => x.symbol !== h.symbol))}>✕</span></span>)}</p>}
          </div>
          <div className="row">
            <button className="btn" disabled={busy} onClick={doPreview}>Aperçu de la proposition</button>
            <button className="btn primary" disabled={busy} onClick={submit}>{isSgi ? "Enregistrer la demande pour ce client" : "Envoyer ma demande de conseil"}</button>
          </div>
          {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
        </div>
        <div className="card">
          <h3>{isSgi ? "Demandes de votre SGI" : "Mes demandes"} ({requests.length})</h3>
          {requests.length === 0 && <p className="muted">Aucune demande pour le moment.</p>}
          <table>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => setOpen(r)}>
                  <td className="left mono muted">{fmtDateTime(r.created_at)}</td>
                  <td className="left">{r.client_label ?? "Moi"}<br /><span className="muted" style={{ fontSize: 11 }}>{fmtFcfa(r.capital)} · {r.horizon_months} mois</span></td>
                  <td className="left"><span className={`badge ${r.status === "validated" ? "buy" : r.status === "declined" ? "sell" : "hold"}`}>{ADVISORY_STATUS_LABEL[r.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {preview && (
        <div className="card">
          <div className="card-head"><h2>Aperçu (non enregistré)</h2><button className="btn sm" onClick={() => setPreview(null)}>Fermer</button></div>
          <AdvisoryReportView v={{ id: 0, user_id: 0, requester_type: isSgi ? "sgi" : "client", sgi_code: null, client_label: form.clientLabel || null, capital: form.capital, objective: form.objective, horizon_months: form.horizonMonths, risk_tolerance: form.riskTolerance, preferred_sectors: form.preferredSectors, constraints: form.constraints || null, holdings, status: "generated", report: preview, analyst_id: null, analyst_note: null, reviewed_at: null, created_at: Date.now(), updated_at: Date.now() }} />
        </div>
      )}
      {open && (
        <div className="card">
          <div className="card-head"><h2>Rapport de conseil</h2><div className="row"><button className="btn sm" onClick={() => window.print()}>Imprimer / PDF</button><button className="btn sm" onClick={() => setOpen(null)}>Fermer</button></div></div>
          <AdvisoryReportView v={open} />
        </div>
      )}
    </div>
  );
}
