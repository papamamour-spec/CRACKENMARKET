import { describe, expect, it } from "vitest";
import { attribute } from "../src/engine/attribution.js";
import { openMemoryDb } from "../src/db/index.js";
import { INSTRUMENTS } from "../src/data/instruments.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { AuthService } from "../src/services/auth.js";
import { TrackingService } from "../src/services/tracking.js";
import { AttributionService } from "../src/services/attribution.js";
import type { HoldingsService } from "../src/services/holdings.js";

describe("attribution de performance (moteur)", () => {
  const sectors = new Map([["A", "Banques"], ["B", "Banques"], ["C", "Télécoms"], ["D", "Agro"]]);
  const bench = { weights: new Map([["A", 0.4], ["B", 0.2], ["C", 0.3], ["D", 0.1]]), returns: new Map([["A", 0.10], ["B", 0.02], ["C", -0.05], ["D", 0.08]]), sectors };
  it("les effets somment exactement à l'écart à l'indice, les contributions au rendement investi", () => {
    const lines = [
      { symbol: "A", sector: "Banques", weight: 0.5, totalReturn: 0.12, priceReturn: 0.08 },
      { symbol: "C", sector: "Télécoms", weight: 0.3, totalReturn: -0.02, priceReturn: -0.04 },
    ];
    const r = attribute(lines, bench, { costRate: 0.02 });
    const rb = 0.4 * 0.1 + 0.2 * 0.02 + 0.3 * -0.05 + 0.1 * 0.08;
    expect(r.benchmarkReturn).toBeCloseTo(rb, 10);
    expect(r.portfolioReturn).toBeCloseTo(0.5 * 0.12 + 0.3 * -0.02, 10);
    expect(r.investedWeight).toBeCloseTo(0.8, 10);
    expect(r.investedReturn).toBeCloseTo(r.portfolioReturn / 0.8, 10);
    // Brinson : Σ effets (sur la poche investie) + liquidités = écart à l'indice
    const explained = r.effects.allocation + r.effects.selection + r.effects.interaction + r.effects.cash;
    expect(explained).toBeCloseTo(r.activeReturn, 10);
    expect(r.effects.cash).toBeCloseTo(-0.2 * rb, 10);
    expect(r.effects.costs).toBe(-0.02);
    expect(r.effects.dividends).toBeCloseTo(0.5 * 0.04 + 0.3 * 0.02, 10);
    const contrib = r.lines.reduce((a, l) => a + l.contributionPct, 0) / 100;
    expect(contrib).toBeCloseTo(r.portfolioReturn, 3);
    expect(r.lines[0].symbol).toBe("A");
    expect(r.lines.find((l) => l.symbol === "A")!.activeWeightPct).toBeCloseTo(10, 6);
    // secteur Agro absent du portefeuille : allocation négative (le secteur a battu l'indice et on ne l'a pas)
    const agro = r.sectors.find((s) => s.sector === "Agro")!;
    expect(agro.weightPortfolioPct).toBe(0);
    expect(agro.allocationPct).toBeLessThan(0);
    expect(agro.selectionPct).toBe(0);
  });
  it("bêta et part de marché quand les séries quotidiennes sont fournies", () => {
    const m = Array.from({ length: 40 }, (_, t) => (t % 3 === 0 ? 0.01 : -0.004));
    const lines = [{ symbol: "A", sector: "Banques", weight: 1, totalReturn: 0.05, priceReturn: 0.05, daily: m.map((x) => 1.5 * x) }];
    const r = attribute(lines, { ...bench, daily: m });
    expect(r.factors.beta).toBeCloseTo(1.5, 2);
    expect(r.factors.marketContribution).toBeCloseTo(1.5 * r.benchmarkReturn, 10);
    expect((r.factors.specific ?? 0) + (r.factors.marketContribution ?? 0)).toBeCloseTo(r.portfolioReturn, 10);
  });
});

describe("attribution de performance (service)", () => {
  async function setup() {
    const db = openMemoryDb();
    ensureHistoryDepth(db, 160);
    const market = new MarketService(db);
    const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void };
    await m.loadOrSeedHistory();
    for (const inst of INSTRUMENTS) m.initSnapshot(inst);
    const userId = new AuthService(db).register("attr@cm.test", "Secret123", "Attribution").id;
    const tracking = new TrackingService(db, market);
    const holdings = { get: () => ({ label: "Mon PEA BRVM", cash: 500_000, updatedAt: null, positions: [{ symbol: "SNTS", assetType: "equity", quantity: 500, avgPrice: null, acquiredAt: null, note: null }, { symbol: "SGBC", assetType: "equity", quantity: 60, avgPrice: null, acquiredAt: null, note: null }, { symbol: "XXXX", assetType: "equity", quantity: 10, avgPrice: null, acquiredAt: null, note: null }] }) } as unknown as HoldingsService;
    return { db, market, userId, tracking, svc: new AttributionService(market, tracking, holdings) };
  }
  it("portefeuille détenu sur 3 mois : référence reconstituée, lignes valorisées, effets cohérents", async () => {
    const { svc, userId } = await setup();
    const r = svc.forHoldings(userId, "3M");
    expect(r.subject.kind).toBe("holdings");
    expect(r.period.sessions).toBeGreaterThan(50);
    expect(r.lines.map((l) => l.symbol).sort()).toEqual(["SGBC", "SNTS"]);
    expect(r.summary.investedWeightPct).toBeGreaterThan(50);
    expect(r.summary.investedWeightPct).toBeLessThan(100);
    const explained = r.effects.allocationPct + r.effects.selectionPct + r.effects.interactionPct + r.effects.cashPct + r.effects.residualPct;
    expect(explained).toBeCloseTo(r.summary.activePct, 1);
    expect(r.sectors.some((s) => s.sector === "Banques")).toBe(true);
    expect(r.factors.beta).not.toBeNull();
    const y = svc.forHoldings(userId, "YTD");
    expect(y.period.label).toMatch(/janvier/);
  });
  it("portefeuille suivi depuis son départ : frais d'entrée et de sortie dans les coûts", async () => {
    const { svc, tracking, userId } = await setup();
    const t = tracking.create(userId, { kind: "manuel", label: "Suivi", capital: 3_000_000, lines: [{ symbol: "SNTS", weightPct: 50 }, { symbol: "ORAC", weightPct: 30 }] });
    const r = svc.forTrackedId(userId, t.id)!;
    expect(r.subject).toMatchObject({ kind: "tracking", id: t.id });
    expect(r.effects.costsPct).toBeLessThan(0);
    expect(r.summary.netPct).toBeCloseTo(r.summary.portfolioPct + r.effects.costsPct, 1);
    expect(svc.forTrackedId(userId + 1, t.id)).toBeNull();
    expect(svc.forTrackingAnyId(t.id)?.subject.id).toBe(t.id);
  });
});
