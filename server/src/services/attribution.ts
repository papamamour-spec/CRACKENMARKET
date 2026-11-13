/**
 * Attribution de performance des portefeuilles suivis (conseils, cibles, modèles) depuis leur départ et
 * du portefeuille détenu sur une période, contre le BRVM Composite reconstitué (mêmes pondérations que
 * l'indice de la plateforme : cours × volume moyen).
 */
import { INSTRUMENT_MAP, INSTRUMENTS } from "../data/instruments.js";
import { attribute, type AttributionResult } from "../engine/attribution.js";
import { oneWayCostRate } from "../engine/costs.js";
import type { MarketService } from "./market.js";
import type { TrackingService, TrackedPortfolio } from "./tracking.js";
import type { HoldingsService } from "./holdings.js";

export type AttributionPeriod = "1M" | "3M" | "6M" | "YTD" | "1Y";
const LOOKBACK: Record<Exclude<AttributionPeriod, "YTD">, number> = { "1M": 21, "3M": 63, "6M": 126, "1Y": 252 };

export interface AttributionReport {
  subject: { kind: "tracking" | "holdings"; id: number | null; label: string };
  period: { from: number; to: number; sessions: number; label: string };
  summary: { portfolioPct: number; investedPct: number; benchmarkPct: number; activePct: number; netPct: number; investedWeightPct: number };
  effects: { allocationPct: number; selectionPct: number; interactionPct: number; cashPct: number; costsPct: number; dividendsPct: number; residualPct: number };
  sectors: AttributionResult["sectors"];
  lines: AttributionResult["lines"];
  factors: { beta: number | null; marketContributionPct: number | null; specificPct: number | null };
  notes: string[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (v: number) => r2(v * 100);

export class AttributionService {
  constructor(private readonly market: MarketService, private readonly tracking: TrackingService, private readonly holdings: HoldingsService) {}

  /** Référence : poids cours × volume moyen au départ, rendements totaux sur la fenêtre, rendements quotidiens de l'indice. */
  private benchmark(from: number, to: number): { weights: Map<string, number>; returns: Map<string, number>; sectors: Map<string, string>; daily: number[]; sessions: number } {
    const weightsRaw = new Map<string, number>();
    const returns = new Map<string, number>();
    const sectors = new Map<string, string>();
    for (const inst of INSTRUMENTS) {
      const adj = this.market.history(inst.symbol, 5000).filter((c) => c.ts >= from && c.ts <= to);
      if (adj.length < 2) continue;
      weightsRaw.set(inst.symbol, adj[0].close * inst.avgVolume * 50);
      returns.set(inst.symbol, adj[adj.length - 1].close / adj[0].close - 1);
      sectors.set(inst.symbol, inst.sector);
    }
    const total = [...weightsRaw.values()].reduce((a, b) => a + b, 0);
    const weights = new Map([...weightsRaw.entries()].map(([s, w]) => [s, total > 0 ? w / total : 0]));
    const idx = this.market.indexHistory(5000).filter((x) => x.ts >= from && x.ts <= to);
    const daily = idx.slice(1).map((x, k) => Math.log(x.composite / idx[k].composite));
    return { weights, returns, sectors, daily, sessions: idx.length };
  }

  private lineInputs(positions: { symbol: string; quantity: number }[], cash: number, from: number, to: number): { lines: Parameters<typeof attribute>[0]; total: number; notes: string[] } {
    const notes: string[] = [];
    const valued: { symbol: string; sector: string; startValue: number; totalReturn: number; priceReturn: number | null; daily: number[] }[] = [];
    for (const p of positions) {
      const inst = INSTRUMENT_MAP.get(p.symbol);
      if (!inst) continue;
      const adj = this.market.history(p.symbol, 5000).filter((c) => c.ts >= from && c.ts <= to);
      const raw = this.market.history(p.symbol, 5000, false).filter((c) => c.ts >= from && c.ts <= to);
      if (adj.length < 2) { notes.push(`${p.symbol} : historique insuffisant sur la période, ligne ignorée`); continue; }
      const startValue = p.quantity * raw[0]?.close || p.quantity * adj[0].close;
      valued.push({ symbol: p.symbol, sector: inst.sector, startValue, totalReturn: adj[adj.length - 1].close / adj[0].close - 1, priceReturn: raw.length >= 2 ? raw[raw.length - 1].close / raw[0].close - 1 : null, daily: adj.slice(1).map((c, k) => Math.log(c.close / adj[k].close)) });
    }
    const total = valued.reduce((a, v) => a + v.startValue, 0) + Math.max(0, cash);
    return { lines: valued.map((v) => ({ symbol: v.symbol, sector: v.sector, weight: total > 0 ? v.startValue / total : 0, totalReturn: v.totalReturn, priceReturn: v.priceReturn, daily: v.daily })), total, notes };
  }

  private build(subject: AttributionReport["subject"], positions: { symbol: string; quantity: number }[], cash: number, from: number, to: number, label: string, costRate: number): AttributionReport {
    const bench = this.benchmark(from, to);
    const { lines, notes } = this.lineInputs(positions, cash, from, to);
    const res = attribute(lines, bench, { costRate });
    const explained = res.effects.allocation + res.effects.selection + res.effects.interaction + res.effects.cash;
    const residual = res.activeReturn - explained;
    const actualTo = Math.max(from, ...lines.map(() => to));
    return {
      subject,
      period: { from, to: actualTo, sessions: bench.sessions, label },
      summary: { portfolioPct: pct(res.portfolioReturn), investedPct: pct(res.investedReturn), benchmarkPct: pct(res.benchmarkReturn), activePct: pct(res.activeReturn), netPct: pct(res.portfolioReturn + res.effects.costs), investedWeightPct: pct(res.investedWeight) },
      effects: { allocationPct: pct(res.effects.allocation), selectionPct: pct(res.effects.selection), interactionPct: pct(res.effects.interaction), cashPct: pct(res.effects.cash), costsPct: pct(res.effects.costs), dividendsPct: pct(res.effects.dividends), residualPct: pct(residual) },
      sectors: res.sectors,
      lines: res.lines,
      factors: { beta: res.factors.beta, marketContributionPct: res.factors.marketContribution != null ? pct(res.factors.marketContribution) : null, specificPct: res.factors.specific != null ? pct(res.factors.specific) : null },
      notes,
    };
  }

  /** Portefeuille suivi : depuis son départ, quantités figées, frais d'entrée et de sortie comptés. */
  forTracked(p: TrackedPortfolio, to = Date.now()): AttributionReport {
    const costRate = p.capital > 0 ? p.entryCost / p.capital + oneWayCostRate() * (p.lines.reduce((a, l) => a + l.amount, 0) / p.capital) : 0;
    return this.build({ kind: "tracking", id: p.id, label: p.label }, p.lines.map((l) => ({ symbol: l.symbol, quantity: l.quantity })), p.cash + p.entryCost, p.startTs, to, `depuis le ${new Date(p.startTs).toLocaleDateString("fr-FR")}`, costRate);
  }

  forTrackedId(userId: number, id: number): AttributionReport | null {
    const v = this.tracking.view(userId, id);
    return v ? this.forTracked(v) : null;
  }

  forTrackingAnyId(id: number): AttributionReport | null {
    const p = this.tracking.byId(id);
    return p ? this.forTracked(p) : null;
  }

  /** Portefeuille détenu : quantités actuelles tenues constantes sur la période (comme la performance passée). */
  forHoldings(userId: number, period: AttributionPeriod = "3M", now = Date.now()): AttributionReport {
    const held = this.holdings.get(userId);
    const idx = this.market.indexHistory(5000);
    let from: number;
    if (period === "YTD") {
      const y = new Date(now).getUTCFullYear();
      from = [...idx].reverse().find((x) => new Date(x.ts).getUTCFullYear() < y)?.ts ?? idx[0]?.ts ?? now;
    } else {
      const k = LOOKBACK[period];
      from = idx[Math.max(0, idx.length - 1 - k)]?.ts ?? now;
    }
    const positions = held.positions.filter((p) => INSTRUMENT_MAP.has(p.symbol.toUpperCase()) && p.quantity > 0).map((p) => ({ symbol: p.symbol.toUpperCase(), quantity: p.quantity }));
    const label = { "1M": "1 mois", "3M": "3 mois", "6M": "6 mois", YTD: "depuis le 1er janvier", "1Y": "1 an" }[period];
    return this.build({ kind: "holdings", id: null, label: held.label ?? "Portefeuille détenu" }, positions, held.cash, from, now, label, 0);
  }
}
