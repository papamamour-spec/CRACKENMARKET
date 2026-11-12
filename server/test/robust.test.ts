import { describe, expect, it } from "vitest";
import { INSTRUMENTS } from "../src/data/instruments.js";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { optimize, shrinkCovariance } from "../src/engine/optimizer.js";
import { blendedCovariance, buildFactorModel, cvarLimitFor, lossMeasures } from "../src/engine/riskmodel.js";
import { DEFAULT_FEES, daysToExit, dividendTaxPct, liquidityCap, netDividend, oneWayCostRate, roundTripCostRate, tradeCost } from "../src/engine/costs.js";
import { marketBetas, stressTest } from "../src/engine/stress.js";
import { rebalancePlan } from "../src/engine/rebalance.js";

const picks = INSTRUMENTS.slice(0, 12);
const closes = new Map(picks.map((i) => [i.symbol, generateDailyHistory(i, 320).map((x) => x.close)]));
const returns = new Map(picks.map((i) => { const c = closes.get(i.symbol)!; return [i.symbol, c.slice(1).map((v, k) => Math.log(v / c[k]))]; }));
const index = (() => {
  const n = 319;
  return Array.from({ length: n }, (_, t) => picks.reduce((a, i) => a + returns.get(i.symbol)![t], 0) / picks.length);
})();
const assets = picks.map((i, k) => ({ symbol: i.symbol, sector: i.sector, expectedReturn: 0.04 + (k % 5) * 0.03, dividendYield: i.dividendYield / 100, price: i.refPrice }));
const constraints = { maxWeight: 0.25, maxSectorWeight: 0.5, maxLines: 6, investedMax: 0.85 };

describe("modèle de risque factoriel", () => {
  const model = buildFactorModel(picks.map((i, k) => ({ symbol: i.symbol, sector: i.sector, marketCap: (k + 1) * 1e9, dividendYieldPct: i.dividendYield })), picks.map((i) => returns.get(i.symbol)!), index);
  it("expositions, facteurs et covariance définie positive", () => {
    expect(model.factors[0]).toBe("marché");
    expect(model.factors).toContain("taille");
    expect(model.factors).toContain("rendement");
    expect(model.factors.some((f) => f.startsWith("secteur"))).toBe(true);
    expect(model.loadings.length).toBe(12);
    expect(model.beta.every((b) => Number.isFinite(b))).toBe(true);
    expect(model.r2.every((r) => r >= 0 && r <= 1)).toBe(true);
    for (let i = 0; i < 12; i++) expect(model.cov[i][i]).toBeGreaterThan(0);
    // symétrie et variance totale ≥ variance spécifique
    expect(model.cov[1][2]).toBeCloseTo(model.cov[2][1], 10);
    expect(model.cov[3][3]).toBeGreaterThanOrEqual(model.specificVar[3] - 1e-12);
  });
  it("la covariance mélangée reste proche de l'échantillon", () => {
    const sample = shrinkCovariance(picks.map((i) => returns.get(i.symbol)!));
    const blend = blendedCovariance(model, picks.map((i) => returns.get(i.symbol)!), 0.5);
    for (let i = 0; i < 12; i++) expect(blend[i][i] / sample[i][i]).toBeGreaterThan(0.5);
  });
  it("CVaR historique et limite par tolérance", () => {
    const w = new Array(12).fill(0.85 / 12);
    const l = lossMeasures(w, picks.map((i) => returns.get(i.symbol)!));
    expect(l.windows).toBeGreaterThan(250);
    expect(l.cvar).toBeGreaterThanOrEqual(l.var);
    expect(l.maxDrawdown).toBeGreaterThan(0);
    expect(cvarLimitFor(1)).toBeLessThan(cvarLimitFor(5));
    expect(lossMeasures([0.1], [[0.01, 0.02]]).windows).toBe(0);
  });
});

describe("optimiseur robuste", () => {
  it("plafonne les poids par liquidité et ramène la part investie si nécessaire", () => {
    const r = optimize(assets, returns, { ...constraints, maxWeightBySymbol: { [assets[0].symbol]: 0.05, [assets[1].symbol]: 0.02 } }, 0.08);
    expect(r.weights.find((w) => w.symbol === assets[0].symbol)?.weight ?? 0).toBeLessThanOrEqual(0.0501);
    expect(r.weights.find((w) => w.symbol === assets[1].symbol)?.weight ?? 0).toBeLessThanOrEqual(0.0201);
    expect(r.liquidityCapped.map((x) => x.symbol)).toEqual([assets[0].symbol, assets[1].symbol]);
    const caps = Object.fromEntries(assets.map((a) => [a.symbol, 0.03]));
    const r2 = optimize(assets, returns, { ...constraints, maxWeightBySymbol: caps }, 0.08);
    expect(r2.invested).toBeLessThanOrEqual(0.3601);
    expect(r2.notes.some((n) => /liquidité/.test(n))).toBe(true);
  });
  it("applique la limite de CVaR en se rapprochant de la variance minimale", () => {
    const free = optimize(assets, returns, constraints, null);
    expect(free.loss.cvar).toBeGreaterThan(0);
    const tight = optimize(assets, returns, { ...constraints, cvarLimit: free.loss.cvar * 0.6 }, null);
    expect(tight.loss.limit).toBeCloseTo(free.loss.cvar * 0.6, 6);
    expect(tight.loss.limited || tight.notes.some((n) => /inatteignable/.test(n))).toBe(true);
    if (tight.loss.limited) {
      expect(tight.loss.cvar).toBeLessThanOrEqual(free.loss.cvar * 0.6 + 1e-6);
      expect(tight.volatility).toBeLessThanOrEqual(free.volatility + 1e-6);
    }
  });
  it("compte les coûts de rotation depuis un portefeuille existant", () => {
    const current = { [assets[0].symbol]: 0.25, [assets[1].symbol]: 0.25, [assets[2].symbol]: 0.2 };
    const r = optimize(assets, returns, { ...constraints, turnover: { current, costPerSide: 0.015, horizonYears: 1 } }, null);
    expect(r.turnover).toBeGreaterThan(0);
    expect(r.costDrag).toBeCloseTo(r.turnover * 0.015, 4);
    expect(r.netExpectedReturn).toBeCloseTo(r.expectedReturn - r.costDrag, 4);
    // avec un coût prohibitif, l'optimiseur bouge moins
    const sticky = optimize(assets, returns, { ...constraints, turnover: { current, costPerSide: 0.2, horizonYears: 0.5 } }, null);
    expect(sticky.turnover).toBeLessThan(r.turnover + 1e-9);
  });
  it("accepte une covariance fournie", () => {
    const model = buildFactorModel(picks.map((i, k) => ({ symbol: i.symbol, sector: i.sector, marketCap: (k + 1) * 1e9, dividendYieldPct: i.dividendYield })), picks.map((i) => returns.get(i.symbol)!), index);
    const r = optimize(assets, returns, constraints, 0.08, 0.06, { covariance: { symbols: model.symbols, matrix: model.cov } });
    expect(r.feasible).toBe(true);
    expect(r.volatility).toBeGreaterThan(0);
  });
});

describe("coûts, fiscalité, liquidité", () => {
  it("frais d'un ordre et taux aller-retour", () => {
    expect(tradeCost(1_000_000, DEFAULT_FEES)).toBeCloseTo(8000 * 1.18 + 1500, 6);
    expect(tradeCost(10_000, DEFAULT_FEES)).toBe(DEFAULT_FEES.minFee);
    expect(oneWayCostRate(DEFAULT_FEES)).toBeCloseTo(0.01094, 5);
    expect(roundTripCostRate(DEFAULT_FEES)).toBeCloseTo(0.02188, 5);
  });
  it("retenue sur dividendes par pays et dividende net", () => {
    expect(dividendTaxPct("CI")).toBe(10);
    expect(dividendTaxPct("BF")).toBe(6);
    expect(dividendTaxPct("ZZ")).toBe(10);
    expect(netDividend(1000, "BF")).toBe(940);
  });
  it("plafond de liquidité et délai de sortie", () => {
    // 10 M FCFA échangés par jour, 25 % de participation, 10 séances → position max 25 M
    expect(liquidityCap(100_000_000, 10_000_000)).toBeCloseTo(0.25, 6);
    expect(liquidityCap(1_000_000, 10_000_000)).toBe(1);
    expect(liquidityCap(100_000_000, 0)).toBe(1);
    expect(daysToExit(25_000_000, 10_000_000)).toBeCloseTo(10, 6);
  });
});

describe("tests de résistance", () => {
  it("scénarios historiques, chocs et taux", () => {
    const betas = marketBetas(returns, index);
    const lines = picks.slice(0, 5).map((i) => ({ symbol: i.symbol, weight: 0.14, beta: betas.get(i.symbol) ?? 1, sector: i.sector, dividendYield: i.dividendYield / 100, returns: returns.get(i.symbol)! }));
    const idx = index.map((r, t) => ({ ts: Date.UTC(2025, 0, 1) + t * 86_400_000, r }));
    const s = stressTest({ lines, index: idx, bonds: { weight: 0.2, duration: 3.5, convexity: 16 }, total: 10_000_000 });
    const keys = s.map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining(["pire_fenetre", "meilleur_rallye", "krach_20", "choc_secteur", "dividende_suspendu", "taux_+100", "taux_+200", "taux_-100"]));
    const worst = s.find((x) => x.key === "pire_fenetre")!;
    const best = s.find((x) => x.key === "meilleur_rallye")!;
    expect(worst.window!.indexPct).toBeLessThan(best.window!.indexPct);
    expect(worst.totalPct).toBeLessThan(best.totalPct);
    const krach = s.find((x) => x.key === "krach_20")!;
    expect(krach.totalPct).toBeLessThan(0);
    expect(krach.bondPct).toBe(0);
    const up = s.find((x) => x.key === "taux_+100")!;
    expect(up.bondPct).toBeLessThan(0);
    expect(up.equityPct).toBe(0);
    expect(up.bondPct).toBeCloseTo((-3.5 * 0.01 + 0.5 * 16 * 0.0001) * 0.2 * 100, 2);
    expect(s.find((x) => x.key === "taux_-100")!.bondPct).toBeGreaterThan(0);
    expect(krach.amount).toBe(Math.round((krach.totalPct / 100) * 10_000_000));
  });
});

describe("rééquilibrage par bandes", () => {
  it("n'agit que hors bande et estime coûts, rotation et prochaine revue", () => {
    const now = Date.UTC(2026, 10, 12);
    const plan = rebalancePlan(
      [{ symbol: "SNTS", weight: 0.3, price: 4200 }, { symbol: "ORAC", weight: 0.2, price: 20_000 }, { symbol: "SGBC", weight: 0.21, price: 20_000 }],
      [{ symbol: "SNTS", weight: 0.2 }, { symbol: "ORAC", weight: 0.2 }, { symbol: "SGBC", weight: 0.2 }, { symbol: "BOAB", weight: 0.1, price: 9500 }],
      10_000_000,
      { absolute: 0.03, relative: 0.25, minTrade: 50_000, reviewMonths: 3 },
      DEFAULT_FEES,
      now,
    );
    expect(plan.trades.map((t) => `${t.side} ${t.symbol}`)).toEqual(["vendre SNTS", "acheter BOAB"]);
    expect(plan.withinBand.map((x) => x.symbol).sort()).toEqual(["ORAC", "SGBC"]);
    expect(plan.trades[0].quantity).toBe(Math.floor(1_000_000 / 4200));
    expect(plan.estimatedCost).toBeGreaterThan(0);
    expect(plan.turnoverPct).toBeGreaterThan(19);
    expect(new Date(plan.nextReview).getUTCMonth()).toBe(1); // février
  });
});
