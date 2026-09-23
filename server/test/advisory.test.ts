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
const market = { price: (s: string) => INSTRUMENT_MAP.get(s)!.refPrice } as unknown as MarketService;
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
