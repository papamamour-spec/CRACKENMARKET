/**
 * Politique de rééquilibrage par bandes de non-échange.
 *
 * Une optimisation ponctuelle produit des mouvements à chaque recalcul ; sur un marché aux frais élevés
 * et à la liquidité mince, on n'agit que lorsqu'une ligne sort de sa bande autour du poids cible :
 * |w − w*| > max(bande absolue, bande relative × w*). On ramène alors la ligne à sa cible. Les autres
 * lignes sont laissées en l'état jusqu'à la prochaine revue périodique.
 */
import { tradeCost, type FeeSchedule, feeSchedule } from "./costs.js";

export interface BandPolicy {
  /** écart absolu toléré, décimal (0,03 = 3 points) */
  absolute: number;
  /** écart relatif toléré, décimal (0,25 = un quart du poids cible) */
  relative: number;
  /** montant minimal d'une opération, FCFA */
  minTrade: number;
  /** revue périodique, mois */
  reviewMonths: number;
}

export const DEFAULT_BANDS: BandPolicy = { absolute: 0.03, relative: 0.25, minTrade: 50_000, reviewMonths: 3 };

export interface RebalanceTrade {
  symbol: string;
  side: "acheter" | "vendre";
  quantity: number;
  amount: number;
  fromPct: number;
  toPct: number;
  /** bande tolérée autour de la cible, points */
  bandPct: number;
  cost: number;
}

export interface RebalancePlan {
  trades: RebalanceTrade[];
  /** lignes dans leur bande : aucune opération */
  withinBand: { symbol: string; currentPct: number; targetPct: number; bandPct: number }[];
  turnoverPct: number;
  estimatedCost: number;
  nextReview: number;
  policy: BandPolicy;
}

export function rebalancePlan(
  current: { symbol: string; weight: number; price: number }[],
  target: { symbol: string; weight: number; price?: number }[],
  total: number,
  policy: BandPolicy = DEFAULT_BANDS,
  fees: FeeSchedule = feeSchedule(),
  now = Date.now(),
): RebalancePlan {
  const cur = new Map(current.map((c) => [c.symbol, c]));
  const tgt = new Map(target.map((t) => [t.symbol, t.weight]));
  const tgtPrice = new Map(target.map((t) => [t.symbol, t.price ?? 0]));
  const symbols = new Set([...cur.keys(), ...tgt.keys()]);
  const trades: RebalanceTrade[] = [];
  const withinBand: RebalancePlan["withinBand"] = [];
  let turnover = 0;
  for (const sym of symbols) {
    const c = cur.get(sym);
    const w = c?.weight ?? 0;
    const w0 = tgt.get(sym) ?? 0;
    const band = Math.max(policy.absolute, policy.relative * w0);
    const price = c?.price ?? tgtPrice.get(sym) ?? 0;
    const r1 = (v: number) => Math.round(v * 1000) / 10;
    if (Math.abs(w - w0) <= band || !(total > 0)) {
      if (w > 0 || w0 > 0) withinBand.push({ symbol: sym, currentPct: r1(w), targetPct: r1(w0), bandPct: r1(band) });
      continue;
    }
    const diff = (w0 - w) * total;
    const px = price > 0 ? price : 0;
    const quantity = px > 0 ? Math.floor(Math.abs(diff) / px) : 0;
    const amount = quantity * px;
    if (quantity === 0 || amount < policy.minTrade) {
      withinBand.push({ symbol: sym, currentPct: r1(w), targetPct: r1(w0), bandPct: r1(band) });
      continue;
    }
    turnover += amount / total;
    trades.push({ symbol: sym, side: diff > 0 ? "acheter" : "vendre", quantity, amount: Math.round(amount), fromPct: r1(w), toPct: r1(w0), bandPct: r1(band), cost: Math.round(tradeCost(amount, fees)) });
  }
  trades.sort((a, b) => (a.side === b.side ? b.amount - a.amount : a.side === "vendre" ? -1 : 1));
  const next = new Date(now);
  next.setUTCMonth(next.getUTCMonth() + policy.reviewMonths);
  return { trades, withinBand, turnoverPct: Math.round(turnover * 1000) / 10, estimatedCost: trades.reduce((a, t) => a + t.cost, 0), nextReview: next.getTime(), policy };
}
