import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { BONDS, type Amortization, type BondDef, type IssuerType } from "../data/bonds.js";
import { analyzeBond, cleanPrice, fullSchedule, type BondAnalytics } from "../engine/bonds.js";

export interface BondQuote {
  code: string;
  price: number; // pied de coupon, FCFA par obligation
  ytmPct: number;
  changePct: number; // variation vs veille
  ts: number;
  source: "simulation" | "manuel";
}

export interface BondView extends BondDef {
  active: boolean;
  quote: BondQuote;
  analytics: Omit<BondAnalytics, "flows">;
}

interface BondRow {
  code: string; name: string; issuer: string; issuer_type: IssuerType; country: string; coupon_pct: number; issue_date: string; maturity_date: string; nominal: number; frequency: number; amortization: Amortization; grace_years: number; tax_exempt: number; active: number; manual_price: number | null; manual_price_at: number | null;
}

const DAY = 86_400_000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Écart de rendement indicatif par type d'émetteur (points de %) par rapport au coupon. */
const SPREAD: Record<IssuerType, number> = { souverain: 0.1, supranational: -0.2, entreprise: 0.9 };

/**
 * Compartiment obligataire : référentiel (base, amorcé depuis `data/bonds.ts`), cotation
 * indicative (rendement simulé autour du coupon + écart d'émetteur, avec retour à la moyenne,
 * ou prix saisi par un administrateur), calculs obligataires et historique de prix pour la
 * mesure du risque des portefeuilles.
 */
export class BondService extends EventEmitter {
  private histCache = new Map<string, { day: number; closes: { ts: number; close: number }[] }>();

  constructor(private readonly db: DB) {
    super();
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM bonds").get() as { n: number }).n;
    if (n === 0) {
      const ins = this.db.prepare("INSERT OR IGNORE INTO bonds(code, name, issuer, issuer_type, country, coupon_pct, issue_date, maturity_date, nominal, frequency, amortization, grace_years, tax_exempt, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)");
      for (const b of BONDS) ins.run(b.code, b.name, b.issuer, b.issuerType, b.country, b.couponPct, b.issueDate, b.maturityDate, b.nominal, b.frequency, b.amortization, b.graceYears, b.taxExempt ? 1 : 0);
    }
  }

  private toDef(r: BondRow): BondDef & { active: boolean; manualPrice: number | null; manualPriceAt: number | null } {
    return { code: r.code, name: r.name, issuer: r.issuer, issuerType: r.issuer_type, country: r.country, couponPct: r.coupon_pct, issueDate: r.issue_date, maturityDate: r.maturity_date, nominal: r.nominal, frequency: r.frequency as 1 | 2 | 4, amortization: r.amortization, graceYears: r.grace_years, taxExempt: !!r.tax_exempt, active: !!r.active, manualPrice: r.manual_price, manualPriceAt: r.manual_price_at };
  }

  defs(includeInactive = false): (BondDef & { active: boolean; manualPrice: number | null; manualPriceAt: number | null })[] {
    const rows = this.db.prepare(`SELECT * FROM bonds ${includeInactive ? "" : "WHERE active = 1"} ORDER BY maturity_date`).all() as BondRow[];
    return rows.map((r) => this.toDef(r));
  }

  def(code: string): (BondDef & { active: boolean; manualPrice: number | null; manualPriceAt: number | null }) | undefined {
    const r = this.db.prepare("SELECT * FROM bonds WHERE code = ?").get(code.toUpperCase()) as BondRow | undefined;
    return r ? this.toDef(r) : undefined;
  }

  has(code: string): boolean {
    return !!this.def(code);
  }

  /** Rendement indicatif simulé au jour j (retour à la moyenne vers coupon + écart). */
  private simulatedYield(b: BondDef, dayIndex: number): number {
    const rand = mulberry32(hash(b.code));
    const base = b.couponPct + SPREAD[b.issuerType];
    let y = base;
    // trajectoire déterministe par code : on rejoue depuis le jour 0 (jusqu'à 400 pas)
    const steps = Math.max(0, Math.min(400, dayIndex));
    const start = Math.max(0, dayIndex - 400);
    for (let i = 0; i < start; i++) rand();
    for (let i = 0; i < steps; i++) y += 0.15 * (base - y) + (rand() - 0.5) * 0.08;
    return y;
  }

  private dayIndex(ts: number): number {
    return Math.floor(ts / DAY);
  }

  /** Cotation indicative (prix pied de coupon) à une date. */
  priceAt(b: BondDef & { manualPrice?: number | null }, at = Date.now()): number {
    if (b.manualPrice && b.manualPrice > 0 && at >= Date.now() - DAY) return b.manualPrice;
    const y = this.simulatedYield(b, this.dayIndex(at)) / 100;
    return Math.round(cleanPrice(b, y, at) * 100) / 100;
  }

  quote(code: string): BondQuote | undefined {
    const b = this.def(code);
    if (!b) return undefined;
    const now = Date.now();
    const price = this.priceAt(b, now);
    const prev = this.priceAt({ ...b, manualPrice: null }, now - DAY);
    const a = analyzeBond(b, price, now);
    return { code: b.code, price, ytmPct: Math.round(a.ytmPct * 100) / 100, changePct: prev ? Math.round(((price - prev) / prev) * 10000) / 100 : 0, ts: now, source: b.manualPrice ? "manuel" : "simulation" };
  }

  view(code: string): BondView | undefined {
    const b = this.def(code);
    if (!b) return undefined;
    const q = this.quote(code)!;
    const { flows: _flows, ...analytics } = analyzeBond(b, q.price);
    return { ...b, quote: q, analytics: round(analytics) };
  }

  list(): BondView[] {
    return this.defs().map((b) => this.view(b.code)!).filter((v) => v.analytics.remainingYears > 0);
  }

  detail(code: string): (BondView & { schedule: ReturnType<typeof fullSchedule>; flows: BondAnalytics["flows"] }) | undefined {
    const v = this.view(code);
    if (!v) return undefined;
    const a = analyzeBond(v, v.quote.price);
    return { ...v, schedule: fullSchedule(v), flows: a.flows };
  }

  /** Historique quotidien de prix pied de coupon (pour la mesure du risque). */
  history(code: string, days = 260): { ts: number; close: number }[] {
    const b = this.def(code);
    if (!b) return [];
    const today = this.dayIndex(Date.now());
    const cached = this.histCache.get(code);
    if (cached && cached.day === today && cached.closes.length >= days) return cached.closes.slice(-days);
    const closes: { ts: number; close: number }[] = [];
    const issue = this.dayIndex(new Date(b.issueDate).getTime());
    for (let d = today - days; d <= today; d++) {
      if (d < issue) continue;
      const ts = d * DAY;
      closes.push({ ts, close: this.priceAt({ ...b, manualPrice: null }, ts) });
    }
    this.histCache.set(code, { day: today, closes });
    return closes;
  }

  /** Administration : création ou mise à jour d'une obligation. */
  upsert(input: BondDef & { active?: boolean }): BondView {
    this.db
      .prepare(
        `INSERT INTO bonds(code, name, issuer, issuer_type, country, coupon_pct, issue_date, maturity_date, nominal, frequency, amortization, grace_years, tax_exempt, active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(code) DO UPDATE SET name=excluded.name, issuer=excluded.issuer, issuer_type=excluded.issuer_type, country=excluded.country, coupon_pct=excluded.coupon_pct, issue_date=excluded.issue_date, maturity_date=excluded.maturity_date, nominal=excluded.nominal, frequency=excluded.frequency, amortization=excluded.amortization, grace_years=excluded.grace_years, tax_exempt=excluded.tax_exempt, active=excluded.active`,
      )
      .run(input.code.toUpperCase(), input.name, input.issuer, input.issuerType, input.country, input.couponPct, input.issueDate, input.maturityDate, input.nominal, input.frequency, input.amortization, input.graceYears, input.taxExempt ? 1 : 0, input.active === false ? 0 : 1);
    this.histCache.delete(input.code.toUpperCase());
    return this.view(input.code)!;
  }

  /** Administration : prix officiel saisi (pied de coupon, FCFA), null pour revenir à la cotation indicative. */
  setPrice(code: string, price: number | null): BondView {
    if (!this.has(code)) throw new Error("Obligation inconnue");
    this.db.prepare("UPDATE bonds SET manual_price = ?, manual_price_at = ? WHERE code = ?").run(price, price ? Date.now() : null, code.toUpperCase());
    return this.view(code)!;
  }

  /**
   * Sélection d'obligations pour un budget : échéance compatible avec l'horizon (au plus horizon + 3 ans,
   * au moins 1 an restant), classement par rendement actuariel corrigé du risque émetteur, diversification
   * des émetteurs (au plus 40 % du budget par émetteur), jusqu'à `maxLines` lignes.
   */
  suggest(budget: number, horizonMonths: number, maxLines = 4, exclude: string[] = [], riskTolerance = 3): BondAllocationLine[] {
    if (!(budget > 0)) return [];
    const maxYears = Math.max(2, horizonMonths / 12 + 3);
    // pénalité de risque émetteur : un profil prudent privilégie les emprunts d'État et supranationaux
    const riskPenalty: Record<IssuerType, number> = { souverain: 0, supranational: 0, entreprise: riskTolerance <= 2 ? 1.5 : riskTolerance === 3 ? 0.8 : 0.4 };
    const candidates = this.list()
      .filter((v) => !exclude.includes(v.code) && v.analytics.remainingYears >= 1 && v.analytics.remainingYears <= maxYears)
      .map((v) => ({ v, score: v.analytics.ytmPct - riskPenalty[v.issuerType] + (v.taxExempt ? 0.3 : 0) }))
      .sort((a, b) => b.score - a.score);
    const chosen: { v: BondView; weight: number }[] = [];
    const issuerBudget = new Map<string, number>();
    for (const c of candidates) {
      if (chosen.length >= maxLines) break;
      const used = issuerBudget.get(c.v.issuer) ?? 0;
      if (used >= 0.4) continue;
      const w = Math.min(0.4 - used, chosen.length === 0 ? 0.4 : 0.3);
      chosen.push({ v: c.v, weight: w });
      issuerBudget.set(c.v.issuer, used + w);
    }
    const totalW = chosen.reduce((a, c) => a + c.weight, 0) || 1;
    const out: BondAllocationLine[] = [];
    for (const c of chosen) {
      const dirty = c.v.quote.price + c.v.analytics.accrued;
      const amount = (budget * c.weight) / totalW;
      const quantity = Math.floor(amount / dirty);
      if (quantity <= 0) continue;
      out.push({
        code: c.v.code,
        name: c.v.name,
        issuer: c.v.issuer,
        issuerType: c.v.issuerType,
        price: c.v.quote.price,
        accrued: c.v.analytics.accrued,
        quantity,
        amount: Math.round(quantity * dirty),
        weightPct: 0,
        couponPct: c.v.couponPct,
        ytmPct: c.v.analytics.ytmPct,
        durationYears: c.v.analytics.modifiedDuration,
        remainingYears: c.v.analytics.remainingYears,
        maturityDate: c.v.maturityDate,
        annualCoupon: Math.round(c.v.analytics.annualCoupon * quantity),
        taxExempt: c.v.taxExempt,
        rationale: `${c.v.issuerType === "souverain" ? "Emprunt d'État" : c.v.issuerType === "supranational" ? "Émetteur supranational" : "Obligation d'entreprise"}, rendement actuariel ${c.v.analytics.ytmPct.toFixed(2)} %${c.v.taxExempt ? " exonéré d'impôt" : ""}, échéance ${c.v.maturityDate.slice(0, 4)} (${c.v.analytics.remainingYears.toFixed(1)} ans)`,
      });
    }
    const sum = out.reduce((a, l) => a + l.amount, 0) || 1;
    for (const l of out) l.weightPct = Math.round((l.amount / sum) * 1000) / 10;
    return out;
  }

  deactivate(code: string): void {
    this.db.prepare("UPDATE bonds SET active = 0 WHERE code = ?").run(code.toUpperCase());
  }
}

/** Part obligataire cible (%) selon le profil : prudence, objectif et horizon. */
export function targetBondSharePct(riskTolerance: number, objective: "income" | "growth" | "balanced" | "speculative", horizonMonths: number): number {
  const tol = Math.max(1, Math.min(5, Math.round(riskTolerance)));
  let share = { 1: 55, 2: 45, 3: 30, 4: 15, 5: 5 }[tol as 1 | 2 | 3 | 4 | 5];
  share += objective === "income" ? 10 : objective === "growth" ? -5 : objective === "speculative" ? -10 : 0;
  if (horizonMonths < 24) share += 10;
  else if (horizonMonths > 96) share -= 5;
  return Math.max(0, Math.min(70, share));
}

export interface BondAllocationLine {
  code: string;
  name: string;
  issuer: string;
  issuerType: IssuerType;
  price: number; // pied de coupon
  accrued: number;
  quantity: number;
  amount: number; // coupon attaché
  weightPct: number; // du budget obligataire
  couponPct: number;
  ytmPct: number;
  durationYears: number;
  remainingYears: number;
  maturityDate: string;
  annualCoupon: number;
  taxExempt: boolean;
  rationale: string;
}

function round<T extends Record<string, unknown>>(a: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) out[k] = typeof v === "number" ? Math.round(v * 100) / 100 : v;
  return out as T;
}
