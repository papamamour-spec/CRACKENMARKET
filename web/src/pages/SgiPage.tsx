import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMarket } from "../hooks/useMarket";
import { api, del, post } from "../lib/api";
import { fmtDateTime, fmtFcfa, fmtNum } from "../lib/format";
import { SGI_STATUS_LABEL, type SgiAccount, type SgiOrder, type SgiPartner } from "../lib/types";

const ID_TYPES = [["cni", "Carte nationale d'identité"], ["passeport", "Passeport"], ["carte_consulaire", "Carte consulaire"], ["rccm", "RCCM (personne morale)"]];
const COUNTRIES = [["SN", "Sénégal"], ["CI", "Côte d'Ivoire"], ["BJ", "Bénin"], ["BF", "Burkina Faso"], ["ML", "Mali"], ["NE", "Niger"], ["TG", "Togo"], ["GW", "Guinée-Bissau"], ["FR", "France"], ["XX", "Autre"]];

export function SgiPage() {
  const { notifications } = useMarket();
  const [partners, setPartners] = useState<SgiPartner[]>([]);
  const [accounts, setAccounts] = useState<SgiAccount[]>([]);
  const [orders, setOrders] = useState<SgiOrder[]>([]);
  const [selected, setSelected] = useState<string>("MATHA");
  const [form, setForm] = useState({ holderName: "", idType: "cni", idNumber: "", phone: "", address: "", country: "SN", accountNumber: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [events, setEvents] = useState<Record<number, { status: string; actor: string; message: string | null; ts: number }[]>>({});

  const load = () => {
    api<SgiPartner[]>("/sgi/partners").then(setPartners).catch(() => {});
    api<SgiAccount[]>("/sgi/accounts").then(setAccounts).catch(() => {});
    api<SgiOrder[]>("/sgi/orders").then(setOrders).catch(() => {});
  };
  useEffect(load, [notifications.length]);

  const partner = partners.find((p) => p.code === selected);
  const account = accounts.find((a) => a.sgi_code === selected);

  const submit = async () => {
    setMsg(null);
    try {
      await post("/sgi/accounts", { sgiCode: selected, ...form, accountNumber: form.accountNumber || undefined });
      setMsg({ ok: true, text: `Demande transmise à ${partner?.shortName}. Vous serez notifié dès la validation.` });
      load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const toggleEvents = async (id: number) => {
    if (events[id]) return setEvents({ ...events, [id]: undefined as never });
    const ev = await api<(typeof events)[number]>(`/sgi/orders/${id}/events`);
    setEvents({ ...events, [id]: ev });
  };
  const cancel = async (id: number) => {
    try {
      await del(`/sgi/orders/${id}`);
      load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  return (
    <div className="grid">
      <div className="card row">
        <div>
          <h1>Compte-titres et ordres réels</h1>
          <span className="muted">Vos ordres réels sont acheminés vers une SGI agréée par l'AMF-UMOA, seule habilitée à négocier sur la BRVM. CrackenMarket ne détient jamais vos titres ni vos fonds.</span>
        </div>
      </div>
      <div className="two-col">
        <div className="grid">
          {partner && (
            <div className="card">
              <div className="card-head">
                <div><h2>{partner.name}</h2><span className="muted">{partner.city} · SGI partenaire {partner.featured && "· partenaire principal"} · {partner.channelLabel}</span></div>
                <a href={partner.website} target="_blank" rel="noreferrer" className="btn sm">Site de la SGI</a>
              </div>
              <div className="grid grid-2">
                <div>
                  <h3>Pièces à fournir</h3>
                  <ul className="clean">{partner.requiredDocuments.map((d) => <li key={d}>• {d}</li>)}</ul>
                  <p className="muted" style={{ fontSize: 12 }}>Délai indicatif : {partner.onboardingDelay}. Les pièces sont transmises directement à la SGI ; CrackenMarket ne conserve que les références déclarées ci-contre.</p>
                </div>
                <div>
                  <h3>Frais par ordre</h3>
                  <ul className="clean">
                    <li>Courtage SGI : {partner.brokerageFeePct} % (minimum {fmtFcfa(partner.minFee)})</li>
                    <li>Frais BRVM et DC/BR : {partner.marketFeePct} %</li>
                  </ul>
                  {!partner.feesConfirmed && <p className="muted" style={{ fontSize: 12 }}>Barème de référence UEMOA, à confirmer par la convention avec {partner.shortName}.</p>}
                </div>
              </div>
            </div>
          )}
          <div className="card">
            <h2>{account ? "Mon compte-titres" : "Ouvrir un compte-titres"} chez {partner?.shortName}</h2>
            {account ? (
              <div>
                <p>
                  Statut : <span className={`badge ${account.status === "verified" ? "buy" : account.status === "rejected" ? "sell" : "hold"}`}>{{ pending: "En cours de validation par la SGI", verified: "Validé", rejected: "Refusé" }[account.status]}</span>
                  {account.account_number && <span> · n° <b className="mono">{account.account_number}</b></span>}
                </p>
                <p className="muted" style={{ fontSize: 12 }}>Titulaire {account.holder_name} · {ID_TYPES.find(([k]) => k === account.id_type)?.[1]} {account.id_number} · demande du {fmtDateTime(account.created_at)}</p>
                {account.note && <p className="muted">Message de la SGI : {account.note}</p>}
                {account.status === "verified" && <p className="success">Vous pouvez passer des ordres réels depuis la fiche de chaque valeur (mode « Réel via {partner?.shortName} » du ticket d'ordre).</p>}
                {account.status === "rejected" && <button className="btn" onClick={() => setAccounts(accounts.filter((a) => a.id !== account.id))}>Refaire une demande</button>}
              </div>
            ) : (
              <div>
                <div className="grid grid-2">
                  <div className="field"><label>Nom complet du titulaire</label><input value={form.holderName} onChange={(e) => setForm({ ...form, holderName: e.target.value })} /></div>
                  <div className="field"><label>Téléphone</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+221 …" /></div>
                  <div className="field"><label>Type de pièce</label><select value={form.idType} onChange={(e) => setForm({ ...form, idType: e.target.value })}>{ID_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                  <div className="field"><label>Numéro de pièce</label><input value={form.idNumber} onChange={(e) => setForm({ ...form, idNumber: e.target.value })} /></div>
                  <div className="field"><label>Pays de résidence</label><select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>{COUNTRIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                  <div className="field"><label>Adresse</label><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
                  <div className="field" style={{ gridColumn: "1 / -1" }}><label>Déjà client de {partner?.shortName} ? Numéro de compte-titres (facultatif)</label><input value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} /></div>
                </div>
                <button className="btn primary" onClick={submit}>Envoyer ma demande à {partner?.shortName}</button>
                {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
                <p className="disclaimer">En envoyant cette demande, vous autorisez CrackenMarket à transmettre vos coordonnées à la SGI choisie pour l'ouverture de votre compte-titres. La SGI reste seule responsable de la vérification d'identité (KYC) et de la conservation de vos titres.</p>
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <h3>SGI partenaires</h3>
          {partners.map((p) => (
            <div key={p.code} className={`feature ${selected === p.code ? "" : ""}`} style={{ marginBottom: 8, cursor: "pointer", borderColor: selected === p.code ? "var(--accent)" : undefined }} onClick={() => setSelected(p.code)}>
              <b>{p.shortName}</b>
              <p>{p.city} · courtage {p.brokerageFeePct} % · {accounts.find((a) => a.sgi_code === p.code)?.status === "verified" ? "compte validé" : "ouvrir un compte"}</p>
            </div>
          ))}
          <p className="muted" style={{ fontSize: 12 }}>D'autres SGI seront ajoutées au fur et à mesure des conventions signées.</p>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Mes ordres réels</h2><Link to="/portefeuille">Portefeuille virtuel →</Link></div>
        {msg && !msg.ok && <div className="error">{msg.text}</div>}
        {orders.length === 0 ? (
          <p className="muted">Aucun ordre réel transmis pour le moment.</p>
        ) : (
          <table>
            <thead><tr><th className="left">Date</th><th className="left">SGI</th><th className="left">Valeur</th><th className="left">Sens</th><th className="left">Type</th><th>Qté</th><th>Limite</th><th>Montant est.</th><th>Frais est.</th><th className="left">Statut</th><th>Exécuté</th><th></th></tr></thead>
            <tbody>
              {orders.map((o) => (
                <>
                  <tr key={o.id}>
                    <td className="left mono muted">{fmtDateTime(o.created_at)}</td>
                    <td className="left">{o.sgi_code}</td>
                    <td className="left sym">{o.symbol}</td>
                    <td className={`left ${o.side === "buy" ? "up" : "down"}`}>{o.side === "buy" ? "Achat" : "Vente"}</td>
                    <td className="left muted">{o.type === "market" ? "Marché" : "Limite"} · {{ day: "jour", week: "semaine", gtc: "GTC" }[o.validity]}</td>
                    <td className="mono">{o.quantity}</td>
                    <td className="mono">{o.limit_price ? fmtNum(o.limit_price) : "—"}</td>
                    <td className="mono">{fmtNum(o.estimated_amount)}</td>
                    <td className="mono">{fmtNum(o.estimated_fees)}</td>
                    <td className="left"><span className={`badge ${o.status === "executed" ? "buy" : o.status === "rejected" || o.status === "cancelled" ? "sell" : "hold"}`}>{SGI_STATUS_LABEL[o.status]}</span></td>
                    <td className="mono">{o.executed_qty ? `${o.executed_qty} à ${fmtNum(o.executed_price ?? 0)}` : "—"}</td>
                    <td>
                      <button className="btn sm" onClick={() => toggleEvents(o.id)}>Suivi</button>{" "}
                      {["pending", "transmitted", "acknowledged", "partial"].includes(o.status) && <button className="btn sm" onClick={() => cancel(o.id)}>Annuler</button>}
                    </td>
                  </tr>
                  {events[o.id] && (
                    <tr key={`${o.id}-ev`}>
                      <td colSpan={12} className="left" style={{ background: "var(--bg-3)" }}>
                        <ul className="clean">{events[o.id].map((e, i) => <li key={i}><span className="mono muted">{fmtDateTime(e.ts)}</span> · {SGI_STATUS_LABEL[e.status as keyof typeof SGI_STATUS_LABEL] ?? e.status} <span className="muted">({{ client: "client", sgi: "SGI", system: "plateforme" }[e.actor] ?? e.actor})</span>{e.message && ` · ${e.message}`}{o.sgi_reference && i === events[o.id].length - 1 && ` · réf. SGI ${o.sgi_reference}`}</li>)}</ul>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
