import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { AuthService } from "../src/services/auth.js";
import { AdvisoryService } from "../src/services/advisory.js";
import { TrackingService } from "../src/services/tracking.js";
import { MODEL_PROFILES, ModelPortfolioService } from "../src/services/models.js";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../src/data/instruments.js";
import { analyze } from "../src/engine/technical.js";
import type { AdvisorService } from "../src/services/advisor.js";
import type { MarketService } from "../src/services/market.js";
import type { HoldingsService } from "../src/services/holdings.js";

// marché, analyse technique et portefeuille détenu factices sur l'historique synthétique
const histories = new Map(INSTRUMENTS.map((i) => [i.symbol, generateDailyHistory(i, 300)]));
const market = {
  price: (s: string) => INSTRUMENT_MAP.get(s)!.refPrice,
  history: (s: string, n: number) => histories.get(s)!.slice(-n),
  indexHistory: (n: number) => {
    const series = [...histories.values()];
    const len = Math.min(n, ...series.map((h) => h.length));
    return Array.from({ length: len }, (_, k) => {
      const comp = series.reduce((a, h) => a + h[h.length - len + k].close / h[0].close, 0) / series.length;
      return { ts: series[0][series[0].length - len + k].ts, composite: comp * 250, brvm30: comp * 125 };
    });
  },
} as unknown as MarketService;
const cache = new Map<string, ReturnType<typeof analyze>>();
const advisor = { technical: (s: string) => cache.get(s) ?? (cache.set(s, analyze(s, histories.get(s)!)), cache.get(s)!), newsContext: () => new Map() } as unknown as AdvisorService;

function setup() {
  const db = openMemoryDb();
  const userId = new AuthService(db).register("proprio@cm.test", "Secret123", "Propriétaire", "admin").id;
  const advisory = new AdvisoryService(db, market, advisor);
  const tracking = new TrackingService(db, market);
  const models = new ModelPortfolioService(db, market, advisory);
  const holdings = { get: () => ({ label: null, cash: 1_000_000, updatedAt: null, positions: [{ symbol: "SNTS", assetType: "equity", quantity: 1200, avgPrice: null, acquiredAt: null, note: null }, { symbol: "ORAC", assetType: "equity", quantity: 100, avgPrice: null, acquiredAt: null, note: null }] }) } as unknown as HoldingsService;
  models.attach(tracking, holdings, null);
  return { db, userId, models, tracking };
}

describe("portefeuilles modèles par profil", () => {
  it("calcule les quatre profils, publie automatiquement la première version et démarre le suivi", async () => {
    const { models, userId, tracking } = setup();
    expect(models.list().map((m) => m.key)).toEqual(MODEL_PROFILES.map((p) => p.key));
    expect(models.list().every((m) => m.current === null)).toBe(true);
    const r = await models.recompute();
    expect(r.failed).toEqual([]);
    expect(r.computed).toHaveLength(4);
    expect(r.published).toHaveLength(4);
    const list = models.list();
    for (const m of list) {
      expect(m.version).toBe(1);
      expect(m.status).toBe("auto");
      expect(m.current!.lines.length).toBeGreaterThanOrEqual(2);
      const total = m.current!.equityPct + m.current!.bondPct + m.current!.cashPct;
      expect(total).toBeGreaterThan(99);
      expect(total).toBeLessThan(101);
      expect(m.current!.metrics.riskModel).toBe("factoriel");
      expect(m.trackingId).not.toBeNull();
      expect(m.performance?.sessions).toBeGreaterThanOrEqual(1);
      // la proposition et la version publiée sont identiques : aucune dérive
      expect(m.drift?.trades).toEqual([]);
    }
    const prudent = list.find((m) => m.key === "prudent")!;
    const dynamique = list.find((m) => m.key === "dynamique")!;
    expect(prudent.current!.metrics.cvarLimitPct).toBeLessThan(dynamique.current!.metrics.cvarLimitPct!);
    expect(prudent.current!.equityPct).toBeLessThanOrEqual(dynamique.current!.equityPct + 1e-9);
    expect(tracking.list(userId).some((t) => t.kind === "modele")).toBe(true);
  });

  it("publie une proposition avec note, incrémente la version et conserve l'historique", async () => {
    const { models, userId } = setup();
    await models.recompute();
    const before = models.view("equilibre")!;
    const v = models.publish("equilibre", userId, "Revue trimestrielle : validé sans changement");
    expect(v.version).toBe(before.version + 1);
    expect(v.status).toBe("validated");
    expect(v.note).toMatch(/Revue/);
    expect(v.trackingId).not.toBe(before.trackingId);
    const versions = models.versions("equilibre");
    expect(versions.map((x) => x.version)).toEqual([2, 1]);
    expect(() => models.publish("inconnu" as "prudent", userId, null)).toThrow(/inconnu/);
  });

  it("établit un plan de rééquilibrage par bandes du portefeuille détenu vers un modèle", async () => {
    const { models, userId } = setup();
    await models.recompute();
    const plan = models.planFor(userId, "revenus");
    expect(plan.total).toBeGreaterThan(0);
    expect(plan.equityPct + plan.bondPct + plan.cashPct).toBeCloseTo(100, 0);
    expect(plan.target.equityPct).toBeGreaterThan(0);
    expect(plan.plan.trades.length + plan.plan.withinBand.length).toBeGreaterThan(0);
    expect(plan.verdict.length).toBeGreaterThan(10);
    // une ligne détenue absente du modèle est à vendre, ou dans sa bande si elle est petite
    const snts = plan.plan.trades.find((t) => t.symbol === "SNTS") ?? plan.plan.withinBand.find((t) => t.symbol === "SNTS");
    expect(snts).toBeDefined();
  });
});
