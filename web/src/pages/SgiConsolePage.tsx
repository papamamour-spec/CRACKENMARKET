import { useEffect, useState } from "react";
import { useMarket } from "../hooks/useMarket";
import { api, post } from "../lib/api";
import { fmtDateTime, fmtFcfa, fmtNum } from "../lib/format";
import { SGI_STATUS_LABEL, type SgiAccount, type SgiOrder, type SgiOrderStatus } from "../lib/types";

interface Queue {
  sgiCode: string;
  orders: SgiOrder[];
  accounts: SgiAccount[];
  stats: { status: SgiOrderStatus; n: number; amount: number }[];
}

/** Console de traitement pour le personnel de la SGI partenaire (rôle « sgi ») ou l'administrateur. */
export function SgiConsolePage() {
  const { notifications } = useMarket();
  const [q, setQ] = useState<Queue | null>(null);
  const [error, setError] = useState("");
  const [exec, setExec] = useState<Record<number, { qty: number; price: number; ref: string }>>({});
  const [acc, setAcc] = useState<Record<number, { number: string; note: string }>>({});

  const load = () => {
    api<Queue>("/sgi/console").then(setQ).catch((e) => setError(e.message));
  };
  useEffect(load, [notifications.length]);
  useEffect(() => {
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="card error">{error}</div>;
  if (!q) return <div className="card">Chargement de la console…</div>;

  const act = async (o: SgiOrder, status: SgiOrderStatus) => {
    setError("");
    try {
      const e = exec[o.id] ?? { qty: o.quantity, price: o.limit_price ?? 0, ref: "" };
      await post(`/sgi/console/orders/${o.id}`, { status, executedQty: status === "executed" || status === "partial" ? e.qty : undefined, executedPrice: status === "executed" || status === "partial" ? e.price : undefined, reference: e.ref || undefined });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const review = async (a: SgiAccount, decision: "verified" | "rejected") => {
    setError("");
    try {
      const v = acc[a.id] ?? { number: a.account_number ?? "", note: "" };
      await post(`/sgi/console/accounts/${a.id}`, { decision, accountNumber: v.number || undefined, note: v.note || undefined });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const stat = (s: SgiOrderStatus) => q.stats.find((x) => x.status === s);
  const open = q.orders.filter((o) => ["transmitted", "acknowledged", "partial", "pending"].includes(o.status));
  const closed = q.orders.filter((o) => !open.includes(o));
  const pendingAcc = q.accounts.filter((a) => a.status === "pending");

  return (
    <div className="grid">
      <div className="card row">
        <div><h1>Console SGI · {q.sgiCode}</h1><span className="muted">Ordres reçus des clients CrackenMarket et demandes d'ouverture de compte-titres. Actualisation automatique.</span></div>
        <span className="spacer" />
        <div className="kpi"><span className="label">À traiter</span><span className="value">{open.length}</span></div>
        <div className="kpi"><span className="label">Exécutés</span><span className="value up">{stat("executed")?.n ?? 0}</span><span className="sub muted">{fmtFcfa(stat("executed")?.amount ?? 0)}</span></div>
        <div className="kpi"><span className="label">Comptes à valider</span><span className="value">{pendingAcc.length}</span></div>
      </div>
      {error && <div className="card error">{error}</div>}
      <div className="card">
        <h2>Ordres à traiter ({open.length})</h2>
        {open.length === 0 && <p className="muted">Aucun ordre en attente.</p>}
        {open.length > 0 && (
          <table>
            <thead><tr><th className="left">Reçu</th><th className="left">Client</th><th className="left">Compte</th><th className="left">Valeur</th><th className="left">Sens</th><th className="left">Type</th><th>Qté</th><th>Limite</th><th className="left">Statut</th><th className="left">Exécution</th><th className="left">Actions</th></tr></thead>
            <tbody>
              {open.map((o) => {
                const e = exec[o.id] ?? { qty: o.quantity, price: o.limit_price ?? 0, ref: "" };
                return (
                  <tr key={o.id}>
                    <td className="left mono muted">{fmtDateTime(o.created_at)}</td>
                    <td className="left">{o.client_name}<br /><span className="muted" style={{ fontSize: 11 }}>{o.client_email}</span></td>
                    <td className="left mono">{o.account_number ?? "—"}</td>
                    <td className="left sym">{o.symbol}</td>
                    <td className={`left ${o.side === "buy" ? "up" : "down"}`}>{o.side === "buy" ? "Achat" : "Vente"}</td>
                    <td className="left muted">{o.type === "market" ? "Marché" : "Limite"} · {{ day: "jour", week: "semaine", gtc: "GTC" }[o.validity]}</td>
                    <td className="mono">{o.quantity}</td>
                    <td className="mono">{o.limit_price ? fmtNum(o.limit_price) : "—"}</td>
                    <td className="left"><span className="badge hold">{SGI_STATUS_LABEL[o.status]}</span></td>
                    <td className="left">
                      <div className="row" style={{ gap: 4 }}>
                        <input type="number" style={{ width: 70 }} value={e.qty} onChange={(ev) => setExec({ ...exec, [o.id]: { ...e, qty: Number(ev.target.value) } })} title="Quantité exécutée" />
                        <input type="number" style={{ width: 90 }} value={e.price || ""} placeholder="Prix" onChange={(ev) => setExec({ ...exec, [o.id]: { ...e, price: Number(ev.target.value) } })} title="Prix d'exécution" />
                        <input style={{ width: 90 }} value={e.ref} placeholder="Réf." onChange={(ev) => setExec({ ...exec, [o.id]: { ...e, ref: ev.target.value } })} title="Référence back-office" />
                      </div>
                    </td>
                    <td className="left">
                      <div className="row" style={{ gap: 4 }}>
                        {o.status === "transmitted" && <button className="btn sm" onClick={() => act(o, "acknowledged")}>Prendre en charge</button>}
                        <button className="btn sm buy" onClick={() => act(o, e.qty < o.quantity ? "partial" : "executed")}>Exécuter</button>
                        <button className="btn sm sell" onClick={() => act(o, "rejected")}>Rejeter</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="two-col">
        <div className="card">
          <h2>Demandes de compte-titres ({pendingAcc.length} en attente)</h2>
          {q.accounts.length === 0 && <p className="muted">Aucune demande.</p>}
          {q.accounts.map((a) => {
            const v = acc[a.id] ?? { number: a.account_number ?? "", note: "" };
            return (
              <div key={a.id} className="feature" style={{ marginBottom: 8 }}>
                <div className="row">
                  <b>{a.holder_name}</b>
                  <span className={`badge ${a.status === "verified" ? "buy" : a.status === "rejected" ? "sell" : "hold"}`}>{{ pending: "À valider", verified: "Validé", rejected: "Refusé" }[a.status]}</span>
                  <span className="spacer" />
                  <span className="muted" style={{ fontSize: 11 }}>{fmtDateTime(a.created_at)}</span>
                </div>
                <p>{a.client_email} · {a.phone} · {a.id_type.toUpperCase()} {a.id_number} · {a.address} ({a.country})</p>
                {a.status === "pending" && (
                  <div className="row" style={{ gap: 6 }}>
                    <input style={{ width: 160 }} placeholder="N° compte-titres" value={v.number} onChange={(e) => setAcc({ ...acc, [a.id]: { ...v, number: e.target.value } })} />
                    <input style={{ flex: 1 }} placeholder="Message au client (facultatif)" value={v.note} onChange={(e) => setAcc({ ...acc, [a.id]: { ...v, note: e.target.value } })} />
                    <button className="btn sm buy" onClick={() => review(a, "verified")}>Valider</button>
                    <button className="btn sm sell" onClick={() => review(a, "rejected")}>Refuser</button>
                  </div>
                )}
                {a.status !== "pending" && a.account_number && <p className="muted" style={{ margin: 0 }}>n° {a.account_number}</p>}
              </div>
            );
          })}
        </div>
        <div className="card">
          <h2>Historique ({closed.length})</h2>
          <table>
            <tbody>
              {closed.slice(0, 50).map((o) => (
                <tr key={o.id}>
                  <td className="left mono muted">{fmtDateTime(o.updated_at)}</td>
                  <td className="left">{o.client_name}</td>
                  <td className="left sym">{o.symbol}</td>
                  <td className={`left ${o.side === "buy" ? "up" : "down"}`}>{o.side === "buy" ? "A" : "V"} {o.quantity}</td>
                  <td className="left"><span className={`badge ${o.status === "executed" ? "buy" : "sell"}`}>{SGI_STATUS_LABEL[o.status]}</span></td>
                  <td className="mono">{o.executed_qty ? `${o.executed_qty} à ${fmtNum(o.executed_price ?? 0)}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
