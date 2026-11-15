import { describe, expect, it } from "vitest";
import { auc, barriersFor, buildBasket, fitLogistic, kellyFraction, metaFeatures, predictLogistic, trainMetaModel, tripleBarrier, META_FEATURES, type MetaObservation } from "../src/engine/metalabel.js";
import { openMemoryDb } from "../src/db/index.js";
import { INSTRUMENTS } from "../src/data/instruments.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { AuthService } from "../src/services/auth.js";
import { ForecastService } from "../src/services/forecast.js";
import { ShortTermService } from "../src/services/shortterm.js";
import type { AdvisorService } from "../src/services/advisor.js";

describe("triple barrière et barrières", () => {
  it("barrières proportionnelles à la volatilité d'horizon, bornées", () => {
    const b = barriersFor(0.02, 21);
    expect(b.profit).toBeCloseTo(1.5 * 0.02 * Math.sqrt(21), 2);
    expect(b.stop).toBeCloseTo(0.02 * Math.sqrt(21), 2);
    expect(b.maxSessions).toBe(42);
    expect(barriersFor(0.0001, 21).profit).toBeCloseTo(0.03, 3); // plancher 2 %
    expect(barriersFor(0.5, 21).stop).toBeCloseTo(0.6, 3); // plafond 60 %
  });

  it("première barrière touchée sur les clôtures : objectif, seuil, échéance, ou inconnue", () => {
    const spec = { profit: 0.1, stop: 0.05, maxSessions: 5 };
    expect(tripleBarrier([100, 102, 111, 90], 0, spec)).toMatchObject({ reason: "objectif", exitIndex: 2, sessions: 2 });
    expect(tripleBarrier([100, 98, 94, 120], 0, spec)).toMatchObject({ reason: "seuil", exitIndex: 2 });
    const timeout = tripleBarrier([100, 101, 102, 101, 103, 104, 150], 0, spec)!;
    expect(timeout).toMatchObject({ reason: "échéance", exitIndex: 5 });
    expect(timeout.ret).toBeCloseTo(0.04, 10);
    expect(tripleBarrier([100, 101, 102], 0, spec)).toBeNull();
    expect(tripleBarrier([0, 1], 0, spec)).toBeNull();
  });
});

describe("régression logistique et méta-étiquetage", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => { const x = (i % 20) / 10 - 1; const z = Math.sin(i * 0.7); return { x: [x, z], y: (x + 0.3 * z > 0 ? 1 : 0) as 0 | 1 }; });
  it("apprend une frontière linéaire et prédit des probabilités calibrées", () => {
    const r = rows(400);
    const m = fitLogistic(r.map((o) => o.x), r.map((o) => o.y), 0.5);
    expect(m.beta[1]).toBeGreaterThan(0);
    expect(predictLogistic(m, [0.9, 0])).toBeGreaterThan(0.9);
    expect(predictLogistic(m, [-0.9, 0])).toBeLessThan(0.1);
    expect(auc(r.map((o) => predictLogistic(m, o.x)), r.map((o) => o.y))).toBeGreaterThan(0.95);
    expect(auc([0.5, 0.5], [1, 1])).toBeNull();
  });

  it("entraînement avec test chronologique : précision, AUC, fiabilité, rendement des sélectionnés", () => {
    const obs: MetaObservation[] = Array.from({ length: 300 }, (_, i) => {
      const x = META_FEATURES.map((_, j) => (j === 0 ? ((i * 7) % 20) / 10 - 1 : Math.sin(i * (j + 1) * 0.3)));
      const y = (x[0] + 0.2 * x[13] > 0 ? 1 : 0) as 0 | 1;
      return { ts: 1_000_000 + i * 86_400_000, symbol: `S${i % 10}`, x, y, retPct: y ? 4 : -3, reason: y ? "objectif" : "seuil" };
    });
    const { model, stats } = trainMetaModel(obs, 1, 0.55);
    expect(stats.n).toBe(300);
    expect(stats.testN).toBeGreaterThanOrEqual(80);
    expect(stats.accuracy!).toBeGreaterThan(stats.baselineAccuracy!);
    expect(stats.auc!).toBeGreaterThan(0.9);
    expect(stats.brier!).toBeLessThan(stats.baselineBrier!);
    expect(stats.selectedReturnPct!).toBeGreaterThan(stats.allReturnPct!);
    expect(stats.coefficients).toHaveLength(META_FEATURES.length);
    expect(stats.coefficients[0].beta).toBeGreaterThan(0);
    expect(stats.calibration.reduce((a, b) => a + b.n, 0)).toBe(stats.testN);
    expect(predictLogistic(model, obs[0].x)).toBeGreaterThanOrEqual(0);
    expect(() => trainMetaModel(obs.slice(0, 30))).toThrow(/insuffisantes/);
  });

  it("vecteur de contexte : saison, régime de marché, volumes, signaux", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i * 0.2);
    const x = metaFeatures({ expectedPct: 3, probUp: 0.6, confidence: 0.5, hitRate: 0.55, baselineHitRate: 0.5, dailyVolPct: 20, closes, volumes: closes.map((_, i) => (i >= 115 ? 2000 : 1000)), index: closes.map((c) => c * 2), month: 2, signals: { pubDrift: 0.4, divWindow: 0, book5: -0.2, resMom: 1.1 } });
    expect(x).toHaveLength(META_FEATURES.length);
    expect(x[0]).toBeCloseTo(0.3, 6);
    expect(x[3]).toBeCloseTo(0.05, 6);
    expect(x[5]).toBeGreaterThan(0.5); // volumes récents doublés
    expect(x[6]).toBeGreaterThan(0); // au-dessus de la moyenne 50
    expect(x[7]).toBeGreaterThan(0); // marché haussier sur 3 mois
    expect(x[9]).toBe(1); // mars : saison
    expect(x[13]).toBe(1.1);
    expect(metaFeatures({ expectedPct: 0, probUp: 0.5, confidence: 0.3, hitRate: 0.5, baselineHitRate: 0.5, dailyVolPct: 20, closes, volumes: closes.map(() => 1000), index: null, month: 9, signals: { pubDrift: 0, divWindow: 0, book5: 0, resMom: 0 } })[9]).toBe(0);
  });
});

describe("Kelly fractionnaire et panier", () => {
  it("fraction de Kelly asymétrique au quart, nulle si l'espérance est négative", () => {
    expect(kellyFraction(0.6, 0.1, 0.05)).toBeCloseTo(0.25 * (0.6 / 0.05 - 0.4 / 0.1), 6);
    expect(kellyFraction(0.3, 0.05, 0.1)).toBe(0);
    expect(kellyFraction(0.6, 0, 0.1)).toBe(0);
  });

  it("panier : seuil de probabilité, classement par espérance, bornes de poids et de liquidité, jamais de levier", () => {
    const b = { profit: 0.09, stop: 0.06, maxSessions: 42 };
    const cands = [
      { symbol: "A", price: 100, prob: 0.7, expectedPct: 3, barriers: b, liquidityCap: 1 },
      { symbol: "B", price: 100, prob: 0.62, expectedPct: 2, barriers: b, liquidityCap: 0.05 },
      { symbol: "C", price: 100, prob: 0.5, expectedPct: 4, barriers: b, liquidityCap: 1 },
      { symbol: "D", price: 100, prob: 0.8, expectedPct: -1, barriers: b, liquidityCap: 1 },
      { symbol: "E", price: 100, prob: 0.66, expectedPct: 1, barriers: b, liquidityCap: 1 },
    ];
    const r = buildBasket(cands, { maxLines: 8, minProb: 0.55, maxWeightPct: 20, fraction: 0.25, roundTripCost: 0.015 });
    expect(r.lines.map((l) => l.symbol)).toEqual(["A", "E", "B"]);
    expect(r.lines[0].weightPct).toBe(20); // borné par le poids maximal
    expect(r.lines[2].weightPct).toBe(5); // borné par la liquidité
    expect(r.cashPct).toBeCloseTo(100 - r.lines.reduce((a, l) => a + l.weightPct, 0), 6);
    const many = Array.from({ length: 12 }, (_, i) => ({ symbol: `S${i}`, price: 100, prob: 0.9, expectedPct: 5, barriers: b, liquidityCap: 1 }));
    const big = buildBasket(many, { maxLines: 8, maxWeightPct: 30 });
    expect(big.lines).toHaveLength(8);
    expect(big.lines.reduce((a, l) => a + l.weightPct, 0)).toBeLessThanOrEqual(100.01);
    expect(big.cashPct).toBeGreaterThanOrEqual(0);
  });
});

describe("service court terme", () => {
  async function setup() {
    const db = openMemoryDb();
    ensureHistoryDepth(db, 520);
    const market = new MarketService(db);
    const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void; loadIndexBase(): void };
    await m.loadOrSeedHistory();
    for (const inst of INSTRUMENTS) m.initSnapshot(inst);
    m.loadIndexBase();
    const advisor = { newsContext: () => new Map() } as unknown as AdvisorService;
    const forecasts = new ForecastService(market, advisor);
    const svc = new ShortTermService(db, market, forecasts);
    const userId = new AuthService(db).register("ct@cm.test", "Secret123", "Court terme").id;
    return { db, market, svc, userId };
  }

  it("entraîne le modèle secondaire en marche avant, propose des candidats, publie un panier et le revoit", async () => {
    const { svc, userId, market } = await setup();
    expect(svc.status().model).toBeNull();
    const stored = svc.trainSync({ sessions: 160, step: 20, minHistory: 250, panel: false });
    expect(stored.stats.n).toBeGreaterThan(60);
    expect(stored.stats.coefficients).toHaveLength(META_FEATURES.length);
    expect(svc.status().model?.id).toBe(stored.id);
    const c = svc.candidates(5_000_000);
    expect(c.items.length).toBe(INSTRUMENTS.length);
    expect(c.modelId).toBe(stored.id);
    for (const it of c.items) {
      expect(it.prob).toBeGreaterThanOrEqual(0);
      expect(it.prob).toBeLessThanOrEqual(1);
      expect(it.targetPrice).toBeGreaterThan(it.price);
      expect(it.stopPrice).toBeLessThan(it.price);
    }
    const selected = c.items.filter((x) => x.selected);
    expect(selected.length).toBeLessThanOrEqual(8);
    expect(selected.every((x) => x.prob >= 0.55 && x.expectedPct > 0 && x.weightPct > 0 && x.weightPct <= 20)).toBe(true);
    expect(c.cashPct + selected.reduce((a, x) => a + x.weightPct, 0)).toBeCloseTo(100, 0);
    if (!selected.length) {
      expect(() => svc.publish(userId, 5_000_000)).toThrow(/Aucun candidat/);
      return;
    }
    const p = svc.publish(userId, 5_000_000, "premier panier");
    expect(p.status).toBe("actif");
    expect(p.positions.length).toBe(selected.filter((x) => Math.floor((5_000_000 * x.weightPct) / 100 / x.price) > 0).length);
    expect(p.cash).toBeGreaterThan(0);
    expect(p.entryCost).toBeGreaterThan(0);
    expect(p.stats.open).toBe(p.positions.length);
    expect(svc.list(userId)).toHaveLength(1);
    expect(svc.view(userId + 1, p.id)).toBeNull();
    // revue : aucune clôture postérieure à l'entrée → rien ne bouge
    expect(svc.review()).toMatchObject({ reviewed: 1, closed: 0 });
    // une clôture future touche l'objectif de la première ligne : la position se clôt au cours de clôture, frais déduits
    const pos = p.positions[0];
    const ts = p.startTs + 3 * 86_400_000;
    (market as unknown as { candles: Map<string, { ts: number; open: number; high: number; low: number; close: number; volume: number }[]> }).candles.get(pos.symbol)!.push({ ts, open: pos.targetPrice, high: pos.targetPrice, low: pos.targetPrice, close: pos.targetPrice, volume: 1000 });
    const r = svc.review();
    const after = svc.view(userId, p.id)!;
    const closed = after.positions.find((x) => x.id === pos.id)!;
    expect(r.closed).toBe(1);
    {
      expect(closed.exitReason).toBe("objectif");
      expect(closed.exitPrice).toBe(pos.targetPrice);
      expect(after.cash).toBeGreaterThan(p.cash);
      expect(after.stats.closed).toBe(1);
      expect(after.stats.wins).toBe(1);
    }
    // clôture manuelle du reste
    const done = svc.close(userId, p.id)!;
    expect(done.status).toBe("clos");
    expect(done.positions.every((x) => x.exitTs != null)).toBe(true);
    expect(done.stats.open).toBe(0);
  }, 120000);
});
