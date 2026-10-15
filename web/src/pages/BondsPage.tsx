import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { fmtDate, fmtDateTime, fmtNum, fmtPct, signClass } from "../lib/format";
import { AMORT_LABEL, ISSUER_LABEL, type BondDetail, type BondView } from "../lib/types";
import { SkeletonCard } from "../components/Skeleton";

type SortKey = "ytm" | "maturity" | "coupon" | "duration" | "issuer";

/** Compartiment obligataire : emprunts d'État UEMOA, BOAD, entreprises ; détail, échéancier, calculateur. */
export function BondsPage() {
  const [items, setItems] = useState<BondView[] | null>(null);
  const [note, setNote] = useState("");
  const [type, setType] = useState<"all" | BondView["issuerType"]>("all");
  const [sort, setSort] = useState<SortKey>("ytm");
  const [sel, setSel] = useState<BondDetail | null>(null);
  const [calcYield, setCalcYield] = useState<string>("");
  const [calcPrice, setCalcPrice] = useState<string>("");

  useEffect(() => {
    api<{ items: BondView[]; note: string }>("/market/bonds").then((r) => { setItems(r.items); setNote(r.note); }).catch(() => setItems([]));
  }, []);
  const open = (code: string) => api<BondDetail>(`/market/bonds/${code}`).then((d) => { setSel(d); setCalcYield(d.analytics.ytmPct.toFixed(2)); setCalcPrice(String(d.quote.price)); }).catch(() => {});

  const list = useMemo(() => {
    const l = (items ?? []).filter((b) => type === "all" || b.issuerType === type);
    const key: Record<SortKey, (b: BondView) => number | string> = { ytm: (b) => -b.analytics.ytmPct, maturity: (b) => b.maturityDate, coupon: (b) => -b.couponPct, duration: (b) => b.analytics.modifiedDuration, issuer: (b) => b.issuer };
    return l.sort((a, b) => (key[sort](a) < key[sort](b) ? -1 : key[sort](a) > key[sort](b) ? 1 : 0));
  }, [items, type, sort]);
  const avgYtm = list.length ? list.reduce((a, b) => a + b.analytics.ytmPct, 0) / list.length : 0;

  // calculateur : prix ↔ rendement par actualisation des flux restants (même convention que le serveur)
  const priceFromYield = (d: BondDetail, y: number) => d.flows.reduce((a, f) => a + (f.coupon + f.principal) / Math.pow(1 + y / 100, f.years), 0) - d.analytics.accrued;
  const yieldFromPrice = (d: BondDetail, p: number) => {
    let lo = -50; let hi = 100;
    for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (priceFromYield(d, mid) > p) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  };

  return (
    <div className="grid">
      <div className="card row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Obligations</h1>
          <span className="muted">Compartiment obligataire de la BRVM : emprunts d'État de l'UEMOA, émetteurs supranationaux (BOAD, BIDC, CRRH) et obligations d'entreprises. Rendement actuariel, duration, échéancier des coupons et remboursements.</span>
        </div>
        <div className="row">
          <div className="seg">{(["all", "souverain", "supranational", "entreprise"] as const).map((t) => <button key={t} className={type === t ? "active" : ""} onClick={() => setType(t)}>{t === "all" ? "Toutes" : ISSUER_LABEL[t]}</button>)}</div>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={{ width: 200 }}>
            <option value="ytm">Tri : rendement actuariel</option>
            <option value="maturity">Tri : échéance</option>
            <option value="coupon">Tri : coupon</option>
            <option value="duration">Tri : duration</option>
            <option value="issuer">Tri : émetteur</option>
          </select>
        </div>
      </div>
      {!items && <SkeletonCard lines={8} />}
      {items && (
        <>
          <div className="card grid grid-3">
            <div className="kpi"><span className="label">Lignes cotées</span><span className="value">{list.length}</span><span className="sub muted">{items.filter((b) => b.issuerType === "souverain").length} emprunts d'État · {items.filter((b) => b.issuerType === "supranational").length} supranationaux · {items.filter((b) => b.issuerType === "entreprise").length} entreprises</span></div>
            <div className="kpi"><span className="label">Rendement actuariel moyen</span><span className="value">{avgYtm.toFixed(2)} %</span><span className="sub muted">de {Math.min(...list.map((b) => b.analytics.ytmPct)).toFixed(2)} % à {Math.max(...list.map((b) => b.analytics.ytmPct)).toFixed(2)} %</span></div>
            <div className="kpi"><span className="label">Prochains coupons</span><span className="value" style={{ fontSize: 15 }}>{list.filter((b) => b.analytics.nextCoupon).sort((a, b) => a.analytics.nextCoupon!.date - b.analytics.nextCoupon!.date).slice(0, 2).map((b) => `${b.code} ${fmtDate(b.analytics.nextCoupon!.date)}`).join(" · ")}</span><span className="sub muted">par obligation de {fmtNum(list[0]?.nominal ?? 10000)} FCFA de nominal</span></div>
          </div>
          <div className="two-col" style={{ gridTemplateColumns: "3fr 2fr" }}>
            <div className="card">
              <div className="table-scroll">
                <table>
                  <thead><tr><th className="left">Obligation</th><th className="left">Type</th><th>Coupon</th><th>Échéance</th><th>Restant</th><th>Cours</th><th>Veille</th><th>Rdt actuariel</th><th>Duration</th><th>Prochain coupon</th><th>Fiscalité</th></tr></thead>
                  <tbody>
                    {list.map((b) => (
                      <tr key={b.code} style={{ cursor: "pointer" }} className={sel?.code === b.code ? "sel" : ""} onClick={() => open(b.code)}>
                        <td><span className="sym">{b.code}<small>{b.name}</small></span></td>
                        <td className="left muted">{ISSUER_LABEL[b.issuerType]} · {b.country}</td>
                        <td className="mono">{b.couponPct.toFixed(2)} %</td>
                        <td className="mono">{b.maturityDate.slice(0, 7)}</td>
                        <td className="mono muted">{b.analytics.remainingYears.toFixed(1)} ans</td>
                        <td className="mono">{fmtNum(b.quote.price)}<br /><small className="muted">{((b.quote.price / b.analytics.outstanding) * 100).toFixed(1)} % du restant dû</small></td>
                        <td className={`mono ${signClass(b.quote.changePct)}`}>{fmtPct(b.quote.changePct, 2)}</td>
                        <td className="mono"><b>{b.analytics.ytmPct.toFixed(2)} %</b></td>
                        <td className="mono">{b.analytics.modifiedDuration.toFixed(1)}</td>
                        <td className="mono muted">{b.analytics.nextCoupon ? `${fmtDate(b.analytics.nextCoupon.date)} · ${fmtNum(b.analytics.nextCoupon.amount)}` : "—"}</td>
                        <td className="left" style={{ fontSize: 12 }}>{b.taxExempt ? <span className="up">exonérée</span> : <span className="muted">IRVM</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="disclaimer">{note} Cours « pied de coupon » en FCFA par obligation, sur le capital restant dû ; les émissions amortissables ont déjà remboursé une partie du nominal. Source de cotation : {items.some((b) => b.quote.source === "manuel") ? "prix officiels saisis et " : ""}cotation indicative.</p>
            </div>
            <div className="card">
              {!sel && <p className="muted">Sélectionnez une obligation pour voir son échéancier, ses flux restants et le calculateur prix ↔ rendement.</p>}
              {sel && (
                <>
                  <h2 style={{ margin: 0 }}>{sel.code}</h2>
                  <span className="muted" style={{ fontSize: 12 }}>{sel.name} · {sel.issuer} · {AMORT_LABEL[sel.amortization]}{sel.graceYears ? ` après ${sel.graceYears} an(s) de différé` : ""} · {sel.frequency === 1 ? "coupon annuel" : sel.frequency === 2 ? "coupon semestriel" : "coupon trimestriel"} · émise le {fmtDate(Date.parse(sel.issueDate))}</span>
                  <div className="grid grid-2" style={{ gap: 8, marginTop: 10 }}>
                    <div className="kpi"><span className="label">Rendement actuariel</span><span className="value">{sel.analytics.ytmPct.toFixed(2)} %</span><span className="sub muted">rendement courant {sel.analytics.currentYieldPct.toFixed(2)} %</span></div>
                    <div className="kpi"><span className="label">Cours</span><span className="value">{fmtNum(sel.quote.price)}</span><span className="sub muted">+ couru {fmtNum(sel.analytics.accrued)} = {fmtNum(sel.analytics.dirtyPrice)} FCFA · {sel.quote.source === "manuel" ? "prix officiel saisi" : "cotation indicative"} · {fmtDateTime(sel.quote.ts)}</span></div>
                    <div className="kpi"><span className="label">Duration modifiée</span><span className="value">{sel.analytics.modifiedDuration.toFixed(2)}</span><span className="sub muted">Macaulay {sel.analytics.macaulayYears.toFixed(2)} ans · +1 pb de taux ≈ −{sel.analytics.dv01.toFixed(2)} FCFA</span></div>
                    <div className="kpi"><span className="label">Capital restant dû</span><span className="value">{fmtNum(sel.analytics.outstanding)}</span><span className="sub muted">sur {fmtNum(sel.nominal)} · coupon annuel {fmtNum(sel.analytics.annualCoupon)} FCFA</span></div>
                  </div>
                  <h4>Calculateur prix ↔ rendement</h4>
                  <div className="row">
                    <div className="field" style={{ marginBottom: 0 }}><label>Rendement (%)</label><input type="number" step={0.05} value={calcYield} style={{ width: 120 }} onChange={(e) => { setCalcYield(e.target.value); const y = Number(e.target.value); if (Number.isFinite(y)) setCalcPrice(priceFromYield(sel, y).toFixed(0)); }} /></div>
                    <div className="field" style={{ marginBottom: 0 }}><label>Prix pied de coupon (FCFA)</label><input type="number" step={10} value={calcPrice} style={{ width: 140 }} onChange={(e) => { setCalcPrice(e.target.value); const p = Number(e.target.value); if (p > 0) setCalcYield(yieldFromPrice(sel, p).toFixed(2)); }} /></div>
                  </div>
                  <h4 style={{ marginTop: 12 }}>Flux restants par obligation</h4>
                  <div className="table-scroll" style={{ maxHeight: 260, overflowY: "auto" }}>
                    <table>
                      <thead><tr><th className="left">Date</th><th>Coupon</th><th>Capital</th><th>Total</th><th>Restant dû</th></tr></thead>
                      <tbody>
                        {sel.flows.map((f, i) => <tr key={i}><td className="left mono">{fmtDate(f.date)}</td><td className="mono">{fmtNum(f.coupon)}</td><td className="mono">{f.principal ? fmtNum(f.principal) : "—"}</td><td className="mono"><b>{fmtNum(f.coupon + f.principal)}</b></td><td className="mono muted">{fmtNum(f.outstandingAfter)}</td></tr>)}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
