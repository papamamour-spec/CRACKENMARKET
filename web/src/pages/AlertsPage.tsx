import { useEffect, useState } from "react";
import { QuoteTable } from "../components/QuoteTable";
import { useMarket } from "../hooks/useMarket";
import { api, del, post } from "../lib/api";
import { fmtDateTime, fmtNum } from "../lib/format";
import type { Alert, Quote } from "../lib/types";

export function AlertsPage() {
  const { quotes, notifications } = useMarket();
  const [watch, setWatch] = useState<string[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [form, setForm] = useState({ symbol: "SNTS", condition: "above" as Alert["condition"], value: 0 });
  const [error, setError] = useState("");

  const load = () => {
    api<Quote[]>("/watchlist").then((w) => setWatch(w.map((q) => q.symbol))).catch(() => {});
    api<Alert[]>("/alerts").then(setAlerts).catch(() => {});
  };
  useEffect(load, [notifications.length]);

  const create = async () => {
    setError("");
    try {
      await post("/alerts", form);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const symbols = Array.from(quotes.keys()).sort();
  const rows = watch.map((s) => quotes.get(s)).filter((q): q is Quote => !!q);

  return (
    <div className="two-col">
      <div className="card">
        <div className="card-head"><h2>Ma liste de suivi ({rows.length})</h2></div>
        {rows.length ? <QuoteTable rows={rows} /> : <p className="muted">Ajoutez des valeurs depuis leur fiche (bouton « Suivre »).</p>}
      </div>
      <div className="grid">
        <div className="card">
          <h2>Nouvelle alerte</h2>
          <div className="field"><label>Valeur</label><select value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })}>{symbols.map((s) => <option key={s}>{s}</option>)}</select></div>
          <div className="field">
            <label>Condition</label>
            <select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value as Alert["condition"] })}>
              <option value="above">Cours passe au-dessus de</option>
              <option value="below">Cours passe en dessous de</option>
              <option value="pct_move">Variation journalière dépasse (%)</option>
            </select>
          </div>
          <div className="field"><label>{form.condition === "pct_move" ? "Seuil (%)" : `Seuil (FCFA) · cours actuel ${fmtNum(quotes.get(form.symbol)?.price ?? 0)}`}</label><input type="number" value={form.value || ""} onChange={(e) => setForm({ ...form, value: Number(e.target.value) })} /></div>
          {error && <div className="error">{error}</div>}
          <button className="btn primary" onClick={create}>Créer l'alerte</button>
        </div>
        <div className="card">
          <h2>Alertes</h2>
          <table>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id} style={{ opacity: a.active ? 1 : 0.6 }}>
                  <td className="left sym">{a.symbol}</td>
                  <td className="left">{a.condition === "above" ? "≥" : a.condition === "below" ? "≤" : "± %"} {fmtNum(a.value)}</td>
                  <td className="left muted" style={{ fontSize: 12 }}>{a.active ? "active" : `déclenchée ${a.triggered_at ? fmtDateTime(a.triggered_at) : ""}`}</td>
                  <td><button className="btn sm" onClick={() => del(`/alerts/${a.id}`).then(load)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
