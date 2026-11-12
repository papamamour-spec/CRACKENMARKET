import { describe, expect, it } from "vitest";
import { panelModel, PANEL_FACTORS } from "../src/engine/panel.js";
import { applyBlackLitterman, blackLitterman, inverse } from "../src/engine/blacklitterman.js";
import { forecast } from "../src/engine/forecast.js";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { INSTRUMENT_MAP } from "../src/data/instruments.js";
import type { Candle } from "../src/engine/indicators.js";

const DAY = 86_400_000;

function universe(n = 500, symbols = ["SNTS", "SGBC", "BOAB", "PALC", "ETIT", "SHEC", "ORAC", "CIEC"]): Map<string, Candle[]> {
  const end = new Date(Date.UTC(2026, 10, 10));
  return new Map(symbols.map((s, i) => [s, generateDailyHistory(INSTRUMENT_MAP.get(s)!, n, end, INSTRUMENT_MAP.get(s)!.refPrice, i + 3)]));
}

describe("modèle de panel", () => {
  it("entraîne sur toute la cote, prédit un rendement relatif par valeur et horizon, avec test chronologique", () => {
    const u = universe(500);
    const r = panelModel(u, null, { lookback: 400 });
    expect(r.symbols).toBe(8);
    expect(r.stats.map((s) => s.horizon)).toEqual(["1W", "1M", "3M"]);
    for (const s of r.stats) {
      expect(s.samples).toBeGreaterThan(200);
      expect(s.testSamples).toBeGreaterThan(30);
      expect(s.testMaePct).not.toBeNull();
    }
    const p = r.predictions.get("SNTS")!;
    expect(p["1M"]).toBeDefined();
    expect(p["1M"]!.contributions).toHaveLength(PANEL_FACTORS.length);
    // rendements relatifs : leur moyenne sur la cote est proche de zéro
    const rel = [...r.predictions.values()].map((x) => x["1M"]!.relPct);
    expect(Math.abs(rel.reduce((a, b) => a + b, 0) / rel.length)).toBeLessThan(3);
  });

  it("ne lit rien après la date de coupe ; les extras datés entrent dans les facteurs", () => {
    const u = universe(500);
    const cut = u.get("SNTS")![399].ts;
    const a = panelModel(u, cut, { lookback: 300 });
    const tampered = new Map([...u.entries()].map(([s, c]) => [s, c.map((x) => (x.ts > cut ? { ...x, close: x.close * 2 } : x))]));
    const b = panelModel(tampered, cut, { lookback: 300 });
    expect(b.asOf).toBe(cut);
    expect(b.predictions.get("SNTS")!["1M"]!.relPct).toBe(a.predictions.get("SNTS")!["1M"]!.relPct);
    const withExtras = panelModel(u, cut, { lookback: 300, extrasAt: (symbol, ts) => ({ dividendYieldPct: symbol === "SNTS" ? 7 : 4, earningsYieldPct: null, daysToExDividend: ts > cut - 40 * DAY && symbol === "SNTS" ? 10 : null }) });
    const c = withExtras.predictions.get("SNTS")!["1M"]!.contributions;
    expect(c.find((x) => x.factor === "divYield")!.value).toBe(7);
    expect(c.find((x) => x.factor === "exSoon")!.value).toBe(1);
  });

  it("entre dans l'ensemble de prévision comme troisième modèle, avec poids et explication", () => {
    const u = universe(500);
    const candles = u.get("SNTS")!;
    const base = forecast({ symbol: "SNTS", candles, seed: 2 });
    const withPanel = forecast({ symbol: "SNTS", candles, seed: 2, panel: { "1M": { relPct: 4, testMaePct: 5, naiveMaePct: 6, contributions: [{ factor: "rankMom21", label: "Rang du momentum 1 mois sur la cote", value: 0.4, contributionPct: 2.5 }] } } });
    const h = withPanel.horizons.find((x) => x.horizon === "1M")!;
    expect(h.models.panelPct).not.toBeNull();
    expect(h.models.weights.panel).toBeGreaterThan(0);
    expect(h.models.weights.ridge + h.models.weights.ar + h.models.weights.panel).toBeCloseTo(1, 1);
    expect(h.expectedReturnPct).toBeGreaterThan(base.horizons[1].expectedReturnPct);
    expect(h.explanations.some((e) => /modèle de panel/.test(e))).toBe(true);
    expect(h.panelContributions).toHaveLength(1);
    expect(withPanel.horizons.find((x) => x.horizon === "1W")!.models.panelPct).toBeNull();
    expect(base.horizons[1].models.weights.panel).toBe(0);
  });
});

describe("Black-Litterman", () => {
  it("inverse une matrice", () => {
    const inv = inverse([[4, 7], [2, 6]]);
    expect(inv[0][0]).toBeCloseTo(0.6, 6);
    expect(inv[0][1]).toBeCloseTo(-0.7, 6);
    expect(inv[1][0]).toBeCloseTo(-0.2, 6);
    expect(inv[1][1]).toBeCloseTo(0.4, 6);
  });

  it("une vue sûre tire vers la prévision, une vue incertaine reste près de l'équilibre", () => {
    const cov = [[0.04, 0.01, 0.0], [0.01, 0.09, 0.02], [0.0, 0.02, 0.0625]];
    const assets = [
      { symbol: "A", marketCap: 500, view: 0.3, confidence: 0.9 },
      { symbol: "B", marketCap: 300, view: 0.3, confidence: 0.1 },
      { symbol: "C", marketCap: 200, view: 0.0, confidence: 0.5 },
    ];
    const r = blackLitterman(assets, cov, 0.06);
    expect(r.marketWeights).toEqual([0.5, 0.3, 0.2]);
    expect(r.delta).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) expect(r.equilibrium[i]).toBeGreaterThan(0.06);
    // A : vue sûre → postérieur proche de 30 % ; B : vue peu sûre → proche de l'équilibre
    expect(r.posterior[0]).toBeGreaterThan(r.equilibrium[0] + 0.7 * (0.3 - r.equilibrium[0]));
    expect(r.posterior[1]).toBeLessThan(r.equilibrium[1] + 0.3 * (0.3 - r.equilibrium[1]));
    expect(r.viewShare[0]).toBeGreaterThan(r.viewShare[1]);
    // vue en dessous de l'équilibre : le postérieur descend
    expect(r.posterior[2]).toBeLessThan(r.equilibrium[2]);
  });

  it("application à l'univers de l'optimiseur : postérieurs par ligne, valeurs sans historique conservées", () => {
    const u = universe(300, ["SNTS", "SGBC", "BOAB", "PALC"]);
    const returns = new Map([...u.entries()].map(([s, c]) => [s, c.slice(1).map((x, i) => Math.log(x.close / c[i].close))]));
    const assets = [...u.keys()].map((s) => ({ symbol: s, sector: "x", expectedReturn: s === "SNTS" ? 0.35 : 0.08, dividendYield: 0.05, price: 1000 }));
    assets.push({ symbol: "ZZZ", sector: "x", expectedReturn: 0.2, dividendYield: 0, price: 10 });
    const caps = new Map(assets.map((a) => [a.symbol, 1000]));
    const conf = new Map(assets.map((a) => [a.symbol, 0.5]));
    const r = applyBlackLitterman(assets, returns, caps, conf, 0.06);
    expect(r.skipped).toEqual(["ZZZ"]);
    expect(r.lines).toHaveLength(4);
    const snts = r.lines.find((l) => l.symbol === "SNTS")!;
    expect(snts.viewPct).toBe(35);
    expect(snts.posteriorPct).toBeLessThan(35);
    expect(snts.posteriorPct).toBeGreaterThan(snts.equilibriumPct);
    expect(r.assets.find((a) => a.symbol === "ZZZ")!.expectedReturn).toBe(0.2);
    expect(r.assets.find((a) => a.symbol === "SNTS")!.expectedReturn * 100).toBeCloseTo(snts.posteriorPct, 0);
  });
});
