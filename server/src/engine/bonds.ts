/**
 * Calculs obligataires : échéancier de flux, coupon couru, prix ↔ rendement actuariel,
 * duration (Macaulay, modifiée), convexité, sensibilité. Conventions : base ACT/365,
 * composition annuelle du rendement, amortissement « constant » = remboursement du capital par
 * fractions égales après différé, « annuité » = annuités constantes après différé, « in fine ».
 */
import type { BondDef } from "../data/bonds.js";

export interface CashFlow {
  date: number; // ms
  years: number; // depuis la date de valorisation
  coupon: number; // FCFA par obligation
  principal: number; // FCFA par obligation
  outstandingAfter: number; // capital restant dû après le paiement
}

const DAY = 86_400_000;
const YEAR = 365 * DAY;

function addMonths(d: Date, m: number): Date {
  const x = new Date(d.getTime());
  x.setUTCMonth(x.getUTCMonth() + m);
  return x;
}

/** Toutes les dates de paiement de l'émission (coupons), de l'émission à l'échéance. */
export function paymentDates(b: BondDef): Date[] {
  const issue = new Date(b.issueDate);
  const maturity = new Date(b.maturityDate);
  const step = 12 / b.frequency;
  const out: Date[] = [];
  for (let i = 1; ; i++) {
    const d = addMonths(issue, i * step);
    if (d.getTime() > maturity.getTime() + DAY) break;
    out.push(d);
    if (Math.abs(d.getTime() - maturity.getTime()) <= DAY) break;
  }
  return out;
}

/** Échéancier complet (par obligation, en FCFA). */
export function fullSchedule(b: BondDef): { date: number; coupon: number; principal: number; outstandingAfter: number }[] {
  const dates = paymentDates(b);
  const n = dates.length;
  const perYear = b.frequency;
  const graceCount = Math.min(n, Math.round(b.graceYears * perYear));
  const amortCount = Math.max(1, n - graceCount);
  const rate = b.couponPct / 100 / perYear;
  let outstanding = b.nominal;
  const out: { date: number; coupon: number; principal: number; outstandingAfter: number }[] = [];
  // annuité constante : A = N·r / (1 − (1+r)^−k)
  const annuity = b.amortization === "annuite" ? (b.nominal * rate) / (1 - Math.pow(1 + rate, -amortCount)) : 0;
  for (let i = 0; i < n; i++) {
    const coupon = outstanding * rate;
    let principal = 0;
    if (i === n - 1) principal = outstanding;
    else if (i >= graceCount) {
      if (b.amortization === "constant") principal = b.nominal / amortCount;
      else if (b.amortization === "annuite") principal = annuity - coupon;
    }
    principal = Math.min(principal, outstanding);
    outstanding -= principal;
    out.push({ date: dates[i].getTime(), coupon, principal, outstandingAfter: Math.max(0, outstanding) });
  }
  return out;
}

/** Flux restants après la date de valorisation. */
export function remainingCashFlows(b: BondDef, at = Date.now()): CashFlow[] {
  return fullSchedule(b)
    .filter((f) => f.date > at)
    .map((f) => ({ date: f.date, years: (f.date - at) / YEAR, coupon: f.coupon, principal: f.principal, outstandingAfter: f.outstandingAfter }));
}

/** Capital restant dû à la date donnée (par obligation). */
export function outstandingAt(b: BondDef, at = Date.now()): number {
  const past = fullSchedule(b).filter((f) => f.date <= at);
  return past.length ? past[past.length - 1].outstandingAfter : b.nominal;
}

/** Coupon couru (FCFA par obligation) depuis le dernier paiement. */
export function accruedInterest(b: BondDef, at = Date.now()): number {
  const sched = fullSchedule(b);
  const next = sched.find((f) => f.date > at);
  if (!next) return 0;
  const idx = sched.indexOf(next);
  const prevDate = idx > 0 ? sched[idx - 1].date : new Date(b.issueDate).getTime();
  const frac = Math.max(0, Math.min(1, (at - prevDate) / (next.date - prevDate)));
  return next.coupon * frac;
}

/** Prix « coupon attaché » (dirty) pour un rendement actuariel annuel y (décimal). */
export function dirtyPrice(b: BondDef, y: number, at = Date.now()): number {
  return remainingCashFlows(b, at).reduce((a, f) => a + (f.coupon + f.principal) / Math.pow(1 + y, f.years), 0);
}

/** Prix « pied de coupon » (clean) pour un rendement y. */
export function cleanPrice(b: BondDef, y: number, at = Date.now()): number {
  return dirtyPrice(b, y, at) - accruedInterest(b, at);
}

/** Rendement actuariel (décimal) pour un prix pied de coupon donné (bissection, robuste). */
export function yieldFromCleanPrice(b: BondDef, clean: number, at = Date.now()): number {
  const target = clean + accruedInterest(b, at);
  let lo = -0.5;
  let hi = 1.0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const p = dirtyPrice(b, mid, at);
    if (p > target) lo = mid; else hi = mid;
    if (hi - lo < 1e-7) break;
  }
  return (lo + hi) / 2;
}

export interface BondAnalytics {
  cleanPrice: number;
  dirtyPrice: number;
  accrued: number;
  ytmPct: number;
  currentYieldPct: number; // coupon annuel / prix
  macaulayYears: number;
  modifiedDuration: number;
  convexity: number;
  dv01: number; // variation de prix (FCFA par obligation) pour +1 pb
  remainingYears: number;
  outstanding: number;
  annualCoupon: number; // sur le capital restant dû
  nextCoupon: { date: number; amount: number } | null;
  nextPrincipal: { date: number; amount: number } | null;
  flows: CashFlow[];
}

export function analyzeBond(b: BondDef, clean: number, at = Date.now()): BondAnalytics {
  const flows = remainingCashFlows(b, at);
  const accrued = accruedInterest(b, at);
  const dirty = clean + accrued;
  const y = yieldFromCleanPrice(b, clean, at);
  let mac = 0;
  let conv = 0;
  for (const f of flows) {
    const pv = (f.coupon + f.principal) / Math.pow(1 + y, f.years);
    mac += f.years * pv;
    conv += f.years * (f.years + 1) * pv;
  }
  mac = dirty > 0 ? mac / dirty : 0;
  const modified = mac / (1 + y);
  const convexity = dirty > 0 ? conv / (dirty * Math.pow(1 + y, 2)) : 0;
  const outstanding = outstandingAt(b, at);
  const nextCoupon = flows.find((f) => f.coupon > 0);
  const nextPrincipal = flows.find((f) => f.principal > 0);
  return {
    cleanPrice: clean,
    dirtyPrice: dirty,
    accrued,
    ytmPct: y * 100,
    currentYieldPct: clean > 0 ? ((outstanding * b.couponPct) / 100 / clean) * 100 : 0,
    macaulayYears: mac,
    modifiedDuration: modified,
    convexity,
    dv01: modified * dirty * 0.0001,
    remainingYears: flows.length ? flows[flows.length - 1].years : 0,
    outstanding,
    annualCoupon: (outstanding * b.couponPct) / 100,
    nextCoupon: nextCoupon ? { date: nextCoupon.date, amount: nextCoupon.coupon } : null,
    nextPrincipal: nextPrincipal ? { date: nextPrincipal.date, amount: nextPrincipal.principal } : null,
    flows,
  };
}
