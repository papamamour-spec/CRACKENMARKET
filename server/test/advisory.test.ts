import { beforeEach, describe, expect, it } from "vitest";
import { openMemoryDb, type DB } from "../src/db/index.js";
import { AuthService } from "../src/services/auth.js";
import { AdvisoryService } from "../src/services/advisory.js";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../src/data/instruments.js";
import { analyze } from "../src/engine/technical.js";
import type { AdvisorService } from "../src/services/advisor.js";
import type { MarketService } from "../src/services/market.js";

// Marché et analyse technique factices, calculés sur l'historique synthétique
const histories = new Map(INSTRUMENTS.map((i) => [i.symbol, generateDailyHistory(i, 300)]));
const market = { price: (s: string) => INSTRUMENT_MAP.get(s)!.refPrice, history: (s: string, n: number) => histories.get(s)!.slice(-n) } as unknown as MarketService;
const cache = new Map<string, ReturnType<typeof analyze>>();
const advisor = { technical: (s: string) => cache.get(s) ?? (cache.set(s, analyze(s, histories.get(s)!)), cache.get(s)!), newsContext: () => new Map() } as unknown as AdvisorService;

describe("guichet de conseil", () => {
  let db: DB;
  let svc: AdvisoryService;
  let userId: number;
  beforeEach(() => {
    db = openMemoryDb();
    svc = new AdvisoryService(db, market, advisor);
    userId = new AuthService(db).register("c@ex.com", "secret123", "Client Test").id;
  });

  it("génère une proposition cohérente pour un placement de 10 M FCFA", () => {
    const r = svc.generateReport({ capital: 10_000_000, objective: "income", horizonMonths: 36, riskTolerance: 1 });
    expect(r.style).toBe("Prudent");
    expect(r.allocation.length).toBeGreaterThan(0);
    expect(r.investable + r.cashReserve).toBeCloseTo(10_000_000, 0);
    expect(r.cashReserve).toBeGreaterThan(0);
    for (const l of r.allocation) expect(l.quantity * l.price).toBe(l.amount);
    expect(r.scenarios.pessimistic).toBeLessThanOrEqual(r.scenarios.central);
    expect(r.scenarios.central).toBeLessThanOrEqual(r.scenarios.optimistic);
    expect(r.summary.length).toBeGreaterThan(1);
  });

  it("intègre un portefeuille existant dans le diagnostic", () => {
    const r = svc.generateReport({ capital: 2_000_000, objective: "growth", horizonMonths: 24, riskTolerance: 4, holdings: [{ symbol: "SNTS", quantity: 100, avgPrice: 20000 }] });
    expect(r.existing).not.toBeNull();
    expect(r.existing!.diagnostic.lines).toBe(1);
  });

  it("enregistre une demande client, puis une SGI la valide via l'analyste", () => {
    const v = svc.create(userId, "client", null, { capital: 5_000_000, objective: "balanced", horizonMonths: 24, riskTolerance: 3 });
    expect(v.status).toBe("generated");
    expect(svc.listForUser(userId)).toHaveLength(1);
    const reviewed = svc.review(99, v.id, "validated", "Allocation conforme au profil.");
    expect(reviewed.status).toBe("validated");
    expect(reviewed.analyst_note).toContain("conforme");
    expect(svc.inbox()[0].id).toBe(v.id);
  });

  it("exige un client pour une demande de SGI et refuse une SGI inconnue", () => {
    expect(() => svc.create(userId, "sgi", "MATHA", { capital: 1_000_000, objective: "growth", horizonMonths: 12, riskTolerance: 3 })).toThrow(/client/);
    expect(() => svc.create(userId, "sgi", "XXX", { capital: 1_000_000, objective: "growth", horizonMonths: 12, riskTolerance: 3, clientLabel: "Fonds A" })).toThrow(/SGI/);
    const v = svc.create(userId, "sgi", "MATHA", { capital: 50_000_000, objective: "growth", horizonMonths: 60, riskTolerance: 4, clientLabel: "Fonds de pension X" });
    expect(svc.listForSgi("MATHA")).toHaveLength(1);
    expect(v.client_label).toBe("Fonds de pension X");
  });
});

describe("optimiseur dans le conseil", () => {
  it("vise un rendement cible et expose la frontière efficiente", () => {
    const db = openMemoryDb();
    const svc = new AdvisoryService(db, market, advisor);
    const r = svc.generateReport({ capital: 20_000_000, objective: "balanced", horizonMonths: 24, riskTolerance: 3, targetYieldPct: 9, maxLines: 5, maxWeightPct: 30, excludedSectors: ["Banques"] });
    expect(r.optimization.method).toBe("optimizer");
    expect(r.allocation.length).toBeLessThanOrEqual(5);
    for (const l of r.allocation) {
      expect(l.sector).not.toBe("Banques");
      expect(l.weightPct).toBeLessThanOrEqual(30.01);
    }
    expect(r.optimization.frontier.length).toBe(6);
    expect(r.optimization.targetYieldPct).toBe(9);
    expect(r.optimization.volatilityPct).toBeGreaterThan(0);
    expect(r.summary.some((x) => x.includes("optimisée"))).toBe(true);
  });
  it("signale un objectif inatteignable", () => {
    const db = openMemoryDb();
    const svc = new AdvisoryService(db, market, advisor);
    const r = svc.generateReport({ capital: 5_000_000, objective: "growth", horizonMonths: 12, riskTolerance: 4, targetYieldPct: 80 });
    expect(r.optimization.reachedTarget).toBe(false);
    expect(r.warnings.some((x) => x.includes("hors de portée"))).toBe(true);
  });
});

describe("poche obligataire du conseil", () => {
  it("réserve une part obligataire selon le profil et la chiffre", async () => {
    const { BondService } = await import("../src/services/bonds.js");
    const db = openMemoryDb();
    const svc = new AdvisoryService(db, market, advisor);
    svc.attachBonds(new BondService(db));
    const r = svc.generateReport({ capital: 20_000_000, objective: "income", horizonMonths: 48, riskTolerance: 2 });
    expect(r.bonds.targetSharePct).toBeGreaterThanOrEqual(40);
    expect(r.bonds.lines.length).toBeGreaterThan(0);
    expect(r.bonds.lines.length).toBeLessThanOrEqual(4);
    expect(r.bonds.amount).toBeGreaterThan(5_000_000);
    expect(r.bonds.avgYieldPct).toBeGreaterThan(3);
    expect(r.bonds.annualCoupons).toBeGreaterThan(0);
    expect(r.investable + r.bonds.amount + r.cashReserve).toBeCloseTo(20_000_000, -1);
    for (const l of r.bonds.lines) expect(l.quantity * (l.price + l.accrued)).toBeCloseTo(l.amount, -1);
    expect(r.scenarios.pessimistic).toBeLessThanOrEqual(r.scenarios.central);
    expect(r.summary.some((x) => x.startsWith("Poche obligataire"))).toBe(true);
    // part demandée explicitement nulle : aucune obligation
    const none = svc.generateReport({ capital: 20_000_000, objective: "income", horizonMonths: 48, riskTolerance: 2, bondSharePct: 0 });
    expect(none.bonds.lines).toHaveLength(0);
    expect(none.bonds.amount).toBe(0);
  });
});
