/**
 * Contexte de risque partagé par le guichet de conseil et le portefeuille détenu : modèle factoriel
 * construit sur l'historique ajusté et l'indice composite, covariance mélangée, bêtas, rendements de
 * l'indice datés pour les tests de résistance, et rapport de risque (perte, liquidité, coûts, stress).
 */
import { INSTRUMENT_MAP } from "../data/instruments.js";
import { DEFAULT_LIQUIDITY, daysToExit, dividendTaxPct, feeSchedule, liquidityCap, oneWayCostRate, roundTripCostRate, tradeCost, type FeeSchedule, type LiquidityPolicy } from "../engine/costs.js";
import { blendedCovariance, buildFactorModel, type FactorModel } from "../engine/riskmodel.js";
import { stressTest, type StressLine, type StressScenario } from "../engine/stress.js";
import type { MarketService } from "./market.js";

export interface RiskContext {
  model: FactorModel | null;
  covariance: { symbols: string[]; matrix: number[][] } | null;
  /** rendements quotidiens (log) de l'indice composite, datés, alignés par la fin avec les séries des valeurs */
  index: { ts: number; r: number }[];
  betas: Map<string, number>;
  blend: number;
}

/** Modèle factoriel sur les valeurs disposant d'au moins 60 rendements ; covariance = 0,5 facteurs + 0,5 échantillon. */
export function buildRiskContext(market: MarketService, returnsBySymbol: Map<string, number[]>, marketCap: (symbol: string) => number, blend = 0.5): RiskContext {
  const symbols = [...returnsBySymbol.keys()].filter((s) => (returnsBySymbol.get(s)?.length ?? 0) >= 60 && INSTRUMENT_MAP.has(s));
  let idxHist: { ts: number; composite: number; brvm30: number }[] = [];
  try { idxHist = market.indexHistory(Math.max(...symbols.map((s) => returnsBySymbol.get(s)!.length), 60) + 1); } catch { idxHist = []; }
  const index = idxHist.slice(1).map((x, k) => ({ ts: x.ts, r: Math.log(x.composite / idxHist[k].composite) }));
  if (symbols.length < 4 || index.length < 60) return { model: null, covariance: null, index, betas: new Map(), blend };
  const returns = symbols.map((s) => returnsBySymbol.get(s)!);
  const model = buildFactorModel(symbols.map((s) => ({ symbol: s, sector: INSTRUMENT_MAP.get(s)!.sector, marketCap: marketCap(s), dividendYieldPct: INSTRUMENT_MAP.get(s)!.dividendYield })), returns, index.map((x) => x.r));
  const matrix = blendedCovariance(model, returns, blend);
  return { model, covariance: { symbols, matrix }, index, betas: new Map(symbols.map((s, i) => [s, model.beta[i]])), blend };
}

export interface RiskReport {
  model: { kind: "factoriel" | "échantillon"; factors: string[]; observations: number; avgR2: number; blendPct: number };
  loss: { cvar95_1mPct: number; var95_1mPct: number; maxDrawdownPct: number; limitPct: number | null; limited: boolean; amount: number };
  liquidity: { participationPct: number; exitDays: number; capped: { symbol: string; capPct: number }[]; lines: { symbol: string; daysToExit: number; dailyValue: number }[] };
  costs: { entryCost: number; entryPct: number; oneWayPct: number; roundTripPct: number; annualDragPct: number; turnoverPct: number; dividendTax: { country: string; pct: number }[]; fees: FeeSchedule };
  stress: StressScenario[];
}

export interface RiskReportInput {
  ctx: RiskContext;
  /** lignes actions : poids sur la valeur totale, montant, rendements */
  lines: { symbol: string; weight: number; amount: number; returns: number[] | null }[];
  total: number;
  loss: { cvar: number; var: number; maxDrawdown: number; limit: number | null; limited: boolean };
  liquidityCapped: { symbol: string; cap: number }[];
  bonds: { weight: number; duration: number; convexity: number } | null;
  /** rotation : Σ|w − w0| un sens (décimal) et coûts annualisés (décimal) */
  turnover: number;
  costDrag: number;
  /** montant effectivement traité (achats + ventes) pour le coût d'entrée */
  tradedAmount: number;
  liquidity?: LiquidityPolicy;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

export function riskReport(input: RiskReportInput): RiskReport {
  const { ctx, lines, total } = input;
  const policy = input.liquidity ?? DEFAULT_LIQUIDITY;
  const fees = feeSchedule();
  const stressLines: StressLine[] = lines.map((l) => {
    const inst = INSTRUMENT_MAP.get(l.symbol);
    return { symbol: l.symbol, weight: l.weight, beta: ctx.betas.get(l.symbol) ?? 1, sector: inst?.sector ?? "?", dividendYield: (inst?.dividendYield ?? 0) / 100, returns: l.returns };
  });
  const stress = stressTest({ lines: stressLines, index: ctx.index, bonds: input.bonds, total });
  const countries = new Map<string, number>();
  for (const l of lines) {
    const c = INSTRUMENT_MAP.get(l.symbol)?.country;
    if (c) countries.set(c, dividendTaxPct(c));
  }
  const entryCost = input.tradedAmount > 0 ? lines.reduce((a, l) => a + (l.amount > 0 ? tradeCost(l.amount, fees) : 0), 0) : 0;
  return {
    model: ctx.model ? { kind: "factoriel", factors: ctx.model.factors, observations: ctx.model.observations, avgR2: r2(ctx.model.r2.reduce((a, b) => a + b, 0) / Math.max(1, ctx.model.r2.length)), blendPct: Math.round(ctx.blend * 100) } : { kind: "échantillon", factors: [], observations: 0, avgR2: 0, blendPct: 0 },
    loss: { cvar95_1mPct: r1(input.loss.cvar * 100), var95_1mPct: r1(input.loss.var * 100), maxDrawdownPct: r1(input.loss.maxDrawdown * 100), limitPct: input.loss.limit != null ? r1(input.loss.limit * 100) : null, limited: input.loss.limited, amount: Math.round(input.loss.cvar * total) },
    liquidity: {
      participationPct: Math.round(policy.participation * 100),
      exitDays: policy.exitDays,
      capped: input.liquidityCapped.map((c) => ({ symbol: c.symbol, capPct: r1(c.cap * 100) })),
      lines: lines.filter((l) => l.amount > 0).map((l) => {
        const inst = INSTRUMENT_MAP.get(l.symbol);
        const dailyValue = inst ? inst.avgVolume * (inst.refPrice) : 0;
        return { symbol: l.symbol, daysToExit: r1(Math.min(999, daysToExit(l.amount, dailyValue, policy.participation))), dailyValue: Math.round(dailyValue) };
      }).sort((a, b) => b.daysToExit - a.daysToExit),
    },
    costs: { entryCost: Math.round(entryCost), entryPct: r2(total ? (entryCost / total) * 100 : 0), oneWayPct: r2(oneWayCostRate(fees) * 100), roundTripPct: r2(roundTripCostRate(fees) * 100), annualDragPct: r2(input.costDrag * 100), turnoverPct: r1(input.turnover * 100), dividendTax: [...countries.entries()].map(([country, pct]) => ({ country, pct })), fees },
    stress,
  };
}

/** Plafonds de poids par valeur selon la liquidité (capitaux échangés = volume moyen × cours). */
export function liquidityCaps(capital: number, symbols: string[], price: (symbol: string) => number, policy: LiquidityPolicy = DEFAULT_LIQUIDITY): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of symbols) {
    const inst = INSTRUMENT_MAP.get(s);
    if (!inst) continue;
    out[s] = liquidityCap(capital, inst.avgVolume * price(s), policy);
  }
  return out;
}
