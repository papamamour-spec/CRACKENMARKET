import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import { openMemoryDb, type DB } from "../src/db/index.js";
import { AuthService } from "../src/services/auth.js";
import { PortfolioService } from "../src/services/portfolio.js";
import { AdvisorService } from "../src/services/advisor.js";
import { HoldingsService } from "../src/services/holdings.js";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../src/data/instruments.js";
import { emptyPerf, type MarketService } from "../src/services/market.js";

// Marché factice sur historique synthétique : prix = dernière clôture, perf 1M calculée
const histories = new Map(INSTRUMENTS.map((i) => [i.symbol, generateDailyHistory(i, 320)]));
function fakeMarket(): MarketService {
  const m = new EventEmitter() as unknown as MarketService & EventEmitter;
  const last = (s: string) => histories.get(s)!.at(-1)!.close;
  Object.assign(m, {
    price: (s: string) => last(s),
    snapshot: (s: string) => {
      const h = histories.get(s)!;
      const perf = { ...emptyPerf(), "1M": ((last(s) - h.at(-22)!.close) / h.at(-22)!.close) * 100 };
      return { symbol: s, price: last(s), changePct: 0, perf };
    },
    history: (s: string, n: number) => histories.get(s)!.slice(-n),
    indexHistory: (n: number) => histories.get("SNTS")!.slice(-n).map((c) => ({ ts: c.ts, composite: c.close / 100, brvm30: c.close / 150 })),
  });
  return m;
}

describe("portefeuille détenu", () => {
  let db: DB;
  let svc: HoldingsService;
  let userId: number;
  beforeEach(() => {
    db = openMemoryDb();
    const market = fakeMarket();
    const portfolios = new PortfolioService(db, market);
    const advisor = new AdvisorService(db, market, portfolios);
    svc = new HoldingsService(db, market, advisor, portfolios);
    userId = new AuthService(db).register("h@ex.com", "secret123", "Holder").id;
  });

  it("enregistre, modifie et relit le portefeuille saisi", () => {
    let p = svc.replace(userId, { label: "Compte SGI", cash: 500_000, positions: [{ symbol: "snts", quantity: 100, avgPrice: 20000, acquiredAt: null, note: null }, { symbol: "XXXX", quantity: 5, avgPrice: null, acquiredAt: null, note: null }] });
    expect(p.positions).toHaveLength(1);
    expect(p.positions[0].symbol).toBe("SNTS");
    expect(p.cash).toBe(500_000);
    p = svc.upsertLine(userId, { symbol: "ORAC", quantity: 50, avgPrice: null, acquiredAt: null, note: null });
    expect(p.positions.map((x) => x.symbol)).toEqual(["ORAC", "SNTS"]);
    p = svc.removeLine(userId, "SNTS");
    expect(p.positions.map((x) => x.symbol)).toEqual(["ORAC"]);
    expect(() => svc.upsertLine(userId, { symbol: "NOPE", quantity: 1, avgPrice: null, acquiredAt: null, note: null })).toThrow();
  });

  it("importe un relevé texte (symbole ou nom de société, séparateurs variés)", () => {
    const { positions, rejected } = svc.parseImport("Valeur;Quantité;PRU\nSNTS;100;21 500\nOrange Côte d'Ivoire\t40\t13000,5\nSGBC 25\nInconnu;3;100\n");
    expect(positions.map((p) => [p.symbol, p.quantity, p.avgPrice])).toEqual([["SNTS", 100, 21500], ["ORAC", 40, 13000.5], ["SGBC", 25, null]]);
    expect(rejected).toEqual(["Inconnu;3;100"]);
  });

  it("analyse le portefeuille : lignes, risque, prévision, actions concrètes", () => {
    svc.replace(userId, { cash: 1_000_000, positions: [
      { symbol: "SNTS", quantity: 400, avgPrice: 18000, acquiredAt: null, note: null },
      { symbol: "ORAC", quantity: 100, avgPrice: 14000, acquiredAt: null, note: null },
      { symbol: "SGBC", quantity: 30, avgPrice: null, acquiredAt: null, note: null },
    ] });
    const a = svc.analyze(userId);
    expect(a.lines).toHaveLength(3);
    expect(a.totals.lines).toBe(3);
    expect(a.totals.total).toBe(a.totals.invested + a.totals.cash);
    expect(a.totals.cost).not.toBeNull();
    expect(a.lines[0].symbol).toBe("SNTS"); // plus grosse ligne
    expect(a.lines[0].weightPct).toBeGreaterThan(50);
    expect(a.lines.find((l) => l.symbol === "SGBC")!.pnl).toBeNull(); // pas de prix de revient
    expect(["alléger", "vendre"]).toContain(a.lines[0].action.kind); // concentration > plafond
    expect(a.lines[0].action.quantity).toBeGreaterThan(0);
    expect(a.risk.volatilityPct).toBeGreaterThan(0);
    expect(a.risk.beta).not.toBeNull();
    expect(a.risk.maxDrawdown1yPct).toBeLessThanOrEqual(0);
    expect(a.risk.var95_1m).toBeGreaterThan(0);
    expect(a.diagnostic.healthScore).toBeGreaterThanOrEqual(0);
    expect(a.performance.portfolioPct["1M"]).not.toBeNull();
    expect(a.performance.indexPct["1M"]).not.toBeNull();
    expect(a.actions.length).toBeGreaterThan(0);
    expect(a.actions[0].priority).toBeLessThanOrEqual(a.actions[a.actions.length - 1].priority);
    expect(a.summary.length).toBeGreaterThanOrEqual(4);
    expect(a.warnings.some((w) => w.includes("pèse"))).toBe(true);
    expect(a.target).not.toBeNull();
    expect(a.target!.trades.length).toBeGreaterThan(0);
    for (const l of a.lines) expect(["ACHAT FORT", "ACHAT", "CONSERVER", "ALLÉGER", "VENTE", "ÉVITER"]).toContain(l.recommendation.action);
  });

  it("analyse sans enregistrement (aperçu) et portefeuille vide", () => {
    const a = svc.analyze(userId, { cash: 0, positions: [{ symbol: "ETIT", quantity: 1000, avgPrice: 18, acquiredAt: null, note: null }] });
    expect(a.lines).toHaveLength(1);
    expect(svc.get(userId).positions).toHaveLength(0);
    const empty = svc.analyze(userId);
    expect(empty.lines).toHaveLength(0);
    expect(empty.summary[0]).toMatch(/Aucune ligne/);
  });
});

describe("portefeuille détenu avec obligations", () => {
  it("valorise les obligations, calcule la poche cible et le calendrier des coupons", async () => {
    const { BondService } = await import("../src/services/bonds.js");
    const db = openMemoryDb();
    const market = fakeMarket();
    const portfolios = new PortfolioService(db, market);
    const advisor = new AdvisorService(db, market, portfolios);
    const svc = new HoldingsService(db, market, advisor, portfolios);
    const bonds = new BondService(db);
    svc.attachBonds(bonds);
    const userId = new AuthService(db).register("b@ex.com", "secret123", "Bond Holder").id;
    const parsed = svc.parseImport("SNTS;100;20000\nTPCI.O30;200;9900\nBOAD 6,00 % 2024-2033;50");
    expect(parsed.positions.map((p) => [p.symbol, p.assetType])).toEqual([["SNTS", "equity"], ["TPCI.O30", "bond"], ["BOAD.O33", "bond"]]);
    svc.replace(userId, { cash: 2_000_000, positions: parsed.positions });
    expect(svc.get(userId).positions.filter((p) => p.assetType === "bond")).toHaveLength(2);
    const a = svc.analyze(userId);
    expect(a.bondLines).toHaveLength(2);
    expect(a.lines).toHaveLength(1);
    expect(a.totals.lines).toBe(3);
    expect(a.totals.bondsValue).toBeGreaterThan(0);
    expect(a.totals.total).toBe(a.totals.invested + a.totals.bondsValue + a.totals.cash);
    expect(a.assetClasses.equitiesPct + a.assetClasses.bondsPct + a.assetClasses.cashPct).toBeCloseTo(100, 0);
    const tpci = a.bondLines.find((l) => l.code === "TPCI.O30")!;
    expect(tpci.ytmPct).toBeGreaterThan(3);
    expect(tpci.durationYears).toBeGreaterThan(0);
    expect(tpci.nextCoupon).not.toBeNull();
    expect(tpci.pnl).not.toBeNull();
    expect(tpci.action.kind).toBe("conserver");
    expect(a.bondSleeve.targetPct).toBeGreaterThan(0);
    expect(a.bondSleeve.avgYieldPct).not.toBeNull();
    expect(a.incomeCalendar.length).toBeGreaterThan(0);
    expect(a.incomeCalendar.every((x) => x.date > Date.now())).toBe(true);
    expect(a.totals.annualIncome).toBe(a.totals.annualDividendIncome + a.totals.annualCouponIncome);
    expect(a.risk.volatilityPct).toBeGreaterThan(0);
    expect(a.summary.some((x) => x.includes("Obligations :"))).toBe(true);
  });
  it("recommande de constituer la poche obligataire quand elle manque", async () => {
    const { BondService } = await import("../src/services/bonds.js");
    const db = openMemoryDb();
    const market = fakeMarket();
    const portfolios = new PortfolioService(db, market);
    const advisor = new AdvisorService(db, market, portfolios);
    const svc = new HoldingsService(db, market, advisor, portfolios);
    svc.attachBonds(new BondService(db));
    const userId = new AuthService(db).register("c2@ex.com", "secret123", "Equity Only").id;
    advisor.saveDeclaredProfile(userId, { riskTolerance: 1, horizonMonths: 36, objective: "income", experience: "beginner", monthlyCapacity: 0, preferredSectors: [] });
    const a = svc.analyze(userId, { cash: 5_000_000, positions: [{ symbol: "SNTS", quantity: 100, avgPrice: null, acquiredAt: null, note: null }] });
    expect(a.bondSleeve.targetPct).toBeGreaterThanOrEqual(50);
    expect(a.bondSleeve.currentPct).toBe(0);
    expect(a.bondSleeve.suggestions.length).toBeGreaterThan(0);
    const act = a.actions.find((x) => x.kind === "obligations");
    expect(act).toBeDefined();
    expect(act!.title).toMatch(/Constituer la poche obligataire/);
  });
});
