/**
 * Simulateur du moteur court terme complet, jour par jour, pour la mesure en marche avant.
 *
 * Entrées : la chronologie des séances, les clôtures par valeur, l'indice, et pour chaque date de
 * rotation la liste des lignes proposées (probabilité apprise, barrières, poids de Kelly), calculées
 * par le service avec les seules données antérieures. Le simulateur applique :
 *  - les barrières : la première touchée (sur les clôtures) clôture la ligne, frais déduits ;
 *  - la protection (variante « complète ») : plancher cliquet, coussin, régime ; si l'exposition dépasse
 *    le plafond, les lignes les moins probables sont soldées ; aux dates de rotation, les lignes
 *    proposées non détenues sont ouvertes dans la limite du plafond ;
 *  - la variante « sans protection » : mêmes lignes, exposition bornée seulement à 100 %.
 * Sorties : courbes (portefeuille, indice), statistiques nettes de frais, journal des opérations.
 */
import type { BasketLine } from "./metalabel.js";
import { cppiState, regimeAt, type CppiConfig, type RegimeKey, DEFAULT_CPPI } from "./protection.js";

export interface SimConfig {
  capital: number;
  /** frais par ordre (décimal, appliqués à l'achat et à la vente) */
  feeRate: number;
  cppi: CppiConfig;
  protection: boolean;
  regime: boolean;
  /** tolérance avant désexposition (décimal de la valeur) */
  tolerance: number;
}

export interface SimTrade { ts: number; symbol: string; side: "achat" | "vente"; price: number; quantity: number; reason: string; retPct: number | null }

export interface SimStats {
  sessions: number;
  totalReturnPct: number;
  annualizedPct: number | null;
  maxDrawdownPct: number;
  volatilityPct: number | null;
  sharpe: number | null;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgTradeReturnPct: number | null;
  avgHoldingSessions: number | null;
  avgExposurePct: number;
  cashShare: number;
  feesPct: number;
  /** répartition des sorties */
  exits: Record<string, number>;
}

export interface SimResult {
  series: { time: number; value: number; portfolioPct: number; benchmarkPct: number; exposurePct: number; regime: RegimeKey | null }[];
  trades: SimTrade[];
  stats: SimStats;
}

export interface SimInput {
  timeline: number[];
  closes: Map<string, Map<number, number>>;
  index: Map<number, number>;
  /** lignes proposées aux dates de rotation */
  proposals: Map<number, BasketLine[]>;
  config: SimConfig;
}

interface OpenPos { symbol: string; entryTs: number; entryIdx: number; entryPrice: number; quantity: number; prob: number; target: number; stop: number; deadlineIdx: number }

const r2 = (v: number) => Math.round(v * 100) / 100;

export const DEFAULT_SIM: Omit<SimConfig, "protection" | "regime"> = { capital: 10_000_000, feeRate: 0.0125, cppi: DEFAULT_CPPI, tolerance: 0.05 };

export function simulate(input: SimInput): SimResult {
  const { timeline, closes, index, proposals, config } = input;
  const idxSeries = timeline.map((ts) => index.get(ts) ?? NaN);
  let cash = config.capital;
  let peak = config.capital;
  const open: OpenPos[] = [];
  const trades: SimTrade[] = [];
  const series: SimResult["series"] = [];
  let fees = 0;
  let exposureSum = 0;
  let cashDays = 0;
  const holding: number[] = [];
  const priceAt = (s: string, i: number, last: Map<string, number>): number => {
    const p = closes.get(s)?.get(timeline[i]);
    if (p != null) last.set(s, p);
    return p ?? last.get(s) ?? 0;
  };
  const last = new Map<string, number>();
  const idx0 = idxSeries.find((v) => Number.isFinite(v)) ?? 1;
  const sell = (pos: OpenPos, i: number, price: number, reason: string) => {
    const amount = pos.quantity * price;
    const fee = amount * config.feeRate;
    fees += fee;
    cash += amount - fee;
    trades.push({ ts: timeline[i], symbol: pos.symbol, side: "vente", price, quantity: pos.quantity, reason, retPct: r2((price / pos.entryPrice - 1) * 100 - 2 * config.feeRate * 100) });
    holding.push(i - pos.entryIdx);
    open.splice(open.indexOf(pos), 1);
  };
  for (let i = 0; i < timeline.length; i++) {
    const ts = timeline[i];
    // 1. barrières sur la clôture du jour
    for (const pos of [...open]) {
      const p = priceAt(pos.symbol, i, last);
      if (!(p > 0) || i <= pos.entryIdx) continue;
      const reason = p >= pos.target ? "objectif" : p <= pos.stop ? "seuil" : i >= pos.deadlineIdx ? "échéance" : null;
      if (reason) sell(pos, i, p, reason);
    }
    // 2. valeur, plancher, plafond d'exposition
    let invested = 0;
    for (const pos of open) invested += pos.quantity * priceAt(pos.symbol, i, last);
    let value = cash + invested;
    peak = Math.max(peak, value);
    const reg = config.regime && Number.isFinite(idxSeries[i]) ? regimeAt(idxSeries.map((v) => (Number.isFinite(v) ? v : 0)), i) : null;
    const st = config.protection ? cppiState(value, peak, reg?.multiplier ?? 1, config.cppi) : { exposure: 1, budget: value, floor: 0, cushion: value, peak, value, rawExposure: 1 };
    // 3. désexposition : lignes les moins probables d'abord
    if (config.protection && value > 0 && invested / value > st.exposure + config.tolerance) {
      const byProb = [...open].sort((a, b) => a.prob - b.prob);
      for (const pos of byProb) {
        if (invested / value <= st.exposure) break;
        const p = priceAt(pos.symbol, i, last);
        if (!(p > 0)) continue;
        invested -= pos.quantity * p;
        sell(pos, i, p, "protection");
        value = cash + invested;
      }
    }
    // 4. rotation : ouvrir les lignes proposées non détenues, dans la limite du plafond
    const prop = proposals.get(ts);
    if (prop) {
      const held = new Set(open.map((o) => o.symbol));
      let room = Math.max(0, st.exposure * value - invested);
      for (const l of prop) {
        if (held.has(l.symbol) || room <= 0) continue;
        const p = priceAt(l.symbol, i, last);
        if (!(p > 0)) continue;
        const amount = Math.min(room, (l.weightPct / 100) * value);
        const quantity = Math.floor(amount / (p * (1 + config.feeRate)));
        if (quantity <= 0) continue;
        const cost = quantity * p;
        const fee = cost * config.feeRate;
        if (cost + fee > cash) continue;
        cash -= cost + fee;
        fees += fee;
        invested += cost;
        room -= cost;
        open.push({ symbol: l.symbol, entryTs: ts, entryIdx: i, entryPrice: p, quantity, prob: l.prob, target: p * (1 + l.barriers.profit), stop: p * (1 - l.barriers.stop), deadlineIdx: i + l.barriers.maxSessions });
        trades.push({ ts, symbol: l.symbol, side: "achat", price: p, quantity, reason: `p = ${Math.round(l.prob * 100)} %`, retPct: null });
      }
      value = cash + invested;
    }
    const exposure = value > 0 ? invested / value : 0;
    exposureSum += exposure;
    if (exposure < 0.05) cashDays++;
    series.push({ time: ts, value: Math.round(value), portfolioPct: r2((value / config.capital - 1) * 100), benchmarkPct: Number.isFinite(idxSeries[i]) ? r2((idxSeries[i] / idx0 - 1) * 100) : 0, exposurePct: Math.round(exposure * 100), regime: reg?.key ?? null });
  }
  // clôture finale des positions ouvertes pour une mesure nette comparable
  const lastI = timeline.length - 1;
  for (const pos of [...open]) {
    const p = priceAt(pos.symbol, lastI, last);
    if (p > 0) sell(pos, lastI, p, "fin de mesure");
  }
  const value = cash;
  if (series.length) series[series.length - 1] = { ...series[series.length - 1], value: Math.round(value), portfolioPct: r2((value / config.capital - 1) * 100) };
  // statistiques
  let pk = -Infinity;
  let mdd = 0;
  const rets: number[] = [];
  series.forEach((s, k) => { pk = Math.max(pk, s.value); mdd = Math.min(mdd, s.value / pk - 1); if (k > 0 && series[k - 1].value > 0) rets.push(Math.log(s.value / series[k - 1].value)); });
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 5 ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sells = trades.filter((t) => t.side === "vente");
  const wins = sells.filter((t) => (t.retPct ?? 0) > 0).length;
  const exits: Record<string, number> = {};
  for (const t of sells) exits[t.reason] = (exits[t.reason] ?? 0) + 1;
  const n = series.length;
  return {
    series,
    trades,
    stats: {
      sessions: n,
      totalReturnPct: r2((value / config.capital - 1) * 100),
      annualizedPct: n >= 60 ? r2(((value / config.capital) ** (252 / n) - 1) * 100) : null,
      maxDrawdownPct: r2(mdd * 100),
      volatilityPct: sd > 0 ? r2(sd * Math.sqrt(252) * 100) : null,
      sharpe: sd > 0 ? r2((mean / sd) * Math.sqrt(252)) : null,
      trades: sells.length,
      wins,
      losses: sells.length - wins,
      winRate: sells.length ? r2(wins / sells.length) : null,
      avgTradeReturnPct: sells.length ? r2(sells.reduce((a, t) => a + (t.retPct ?? 0), 0) / sells.length) : null,
      avgHoldingSessions: holding.length ? Math.round(holding.reduce((a, b) => a + b, 0) / holding.length) : null,
      avgExposurePct: n ? Math.round((exposureSum / n) * 100) : 0,
      cashShare: n ? r2(cashDays / n) : 0,
      feesPct: r2((fees / config.capital) * 100),
      exits,
    },
  };
}
