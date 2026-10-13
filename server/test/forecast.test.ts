import { describe, expect, it } from "vitest";
import { ridge, solve } from "../src/engine/linalg.js";
import { forecast } from "../src/engine/forecast.js";
import { optimize } from "../src/engine/optimizer.js";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { INSTRUMENT_MAP, INSTRUMENTS } from "../src/data/instruments.js";

describe("algèbre", () => {
  it("résout un système linéaire", () => {
    expect(solve([[2, 1], [1, 3]], [3, 5]).map((x) => Math.round(x * 1000) / 1000)).toEqual([0.8, 1.4]);
  });
  it("la ridge retrouve une relation linéaire", () => {
    const X = Array.from({ length: 200 }, (_, i) => [i / 100, ((i * 7) % 13) / 13]);
    const y = X.map(([a, b]) => 1 + 2 * a - 3 * b);
    const beta = ridge(X, y, 0.001);
    expect(beta[0]).toBeCloseTo(1, 1);
    expect(beta[1]).toBeCloseTo(2, 1);
    expect(beta[2]).toBeCloseTo(-3, 1);
  });
});

describe("prévision", () => {
  const inst = INSTRUMENT_MAP.get("SNTS")!;
  const candles = generateDailyHistory(inst, 1300);
  it("produit trois horizons cohérents avec précision mesurée", () => {
    const f = forecast({ symbol: "SNTS", candles });
    expect(f.horizons).toHaveLength(3);
    for (const h of f.horizons) {
      expect(h.quantiles.p5).toBeLessThan(h.quantiles.p50);
      expect(h.quantiles.p50).toBeLessThan(h.quantiles.p95);
      expect(h.probUp).toBeGreaterThanOrEqual(0);
      expect(h.probUp).toBeLessThanOrEqual(1);
      expect(h.accuracy.samples).toBeGreaterThan(30);
      expect(h.contributions.length).toBeGreaterThan(5);
      expect(h.explanations.length).toBeGreaterThan(0);
    }
    expect(f.horizons[2].quantiles.p95 - f.horizons[2].quantiles.p5).toBeGreaterThan(f.horizons[0].quantiles.p95 - f.horizons[0].quantiles.p5);
  });
  it("une actualité défavorable abaisse l'espérance", () => {
    const base = forecast({ symbol: "SNTS", candles });
    const bad = forecast({ symbol: "SNTS", candles, news: { score: -0.9, count: 3 } });
    expect(bad.horizons[1].expectedReturnPct).toBeLessThan(base.horizons[1].expectedReturnPct);
    expect(bad.horizons[1].models.newsAdjustmentPct).toBeLessThan(0);
  });
  it("est déterministe à graine fixée", () => {
    const a = forecast({ symbol: "SNTS", candles, seed: 7 });
    const b = forecast({ symbol: "SNTS", candles, seed: 7 });
    expect(a.horizons[1].probUp).toBe(b.horizons[1].probUp);
  });
});

describe("optimiseur", () => {
  const picks = INSTRUMENTS.slice(0, 12);
  const returns = new Map(picks.map((i) => {
    const c = generateDailyHistory(i, 300).map((x) => x.close);
    return [i.symbol, c.slice(1).map((v, k) => Math.log(v / c[k]))];
  }));
  const assets = picks.map((i, k) => ({ symbol: i.symbol, sector: i.sector, expectedReturn: 0.04 + (k % 5) * 0.03, dividendYield: i.dividendYield / 100, price: i.refPrice }));
  const constraints = { maxWeight: 0.25, maxSectorWeight: 0.5, maxLines: 6, investedMax: 0.85 };

  it("respecte les contraintes et atteint un rendement cible raisonnable", () => {
    const r = optimize(assets, returns, constraints, 0.1);
    const total = r.weights.reduce((a, w) => a + w.weight, 0);
    expect(total).toBeGreaterThan(0.84);
    expect(total).toBeLessThanOrEqual(0.851);
    expect(r.weights.length).toBeLessThanOrEqual(6);
    for (const w of r.weights) expect(w.weight).toBeLessThanOrEqual(0.2501);
    expect(r.expectedReturn).toBeGreaterThan(0.09);
    expect(r.volatility).toBeGreaterThan(0);
    expect(r.frontier.length).toBe(6);
  });
  it("signale un rendement cible inatteignable", () => {
    const r = optimize(assets, returns, constraints, 0.5);
    expect(r.reachedTarget).toBe(false);
    expect(r.notes[0]).toMatch(/supérieur au maximum/);
  });
  it("applique les exclusions", () => {
    const r = optimize(assets, returns, { ...constraints, excludedSectors: ["Banques"] }, 0.08);
    for (const w of r.weights) expect(assets.find((a) => a.symbol === w.symbol)!.sector).not.toBe("Banques");
  });
});
