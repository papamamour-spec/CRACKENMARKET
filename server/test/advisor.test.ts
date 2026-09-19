import { describe, expect, it } from "vitest";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { INSTRUMENT_MAP } from "../src/data/instruments.js";
import { analyze } from "../src/engine/technical.js";
import { buildBehaviorProfile } from "../src/engine/behavior.js";
import { diagnosePortfolio, recommend } from "../src/engine/advisor.js";
import { backtest } from "../src/engine/backtest.js";

const declared = { riskTolerance: 3, horizonMonths: 24, objective: "growth" as const, experience: "intermediate" as const, monthlyCapacity: 100000, preferredSectors: ["Banques"] };

describe("moteur de conseil", () => {
  const inst = INSTRUMENT_MAP.get("SNTS")!;
  const candles = generateDailyHistory(inst, 400);

  it("l'historique synthétique se termine au prix de référence", () => {
    expect(candles.length).toBe(400);
    expect(candles[candles.length - 1].close).toBe(inst.refPrice);
    for (const c of candles) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    }
  });

  it("l'analyse technique produit des scores bornés", () => {
    const t = analyze("SNTS", candles);
    for (const v of Object.values(t.scores)) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(t.rsi14).toBeGreaterThanOrEqual(0);
    expect(t.rsi14).toBeLessThanOrEqual(100);
  });

  it("le profil comportemental détecte la concentration", () => {
    const profile = buildBehaviorProfile(declared, [], [], [{ symbol: "SNTS", quantity: 100, avgPrice: 20000, currentPrice: 22000, sector: "Télécommunications" }]);
    expect(profile.biases.some((b) => b.code === "concentration")).toBe(true);
    expect(profile.style).toBe("Équilibré");
  });

  it("le profil détecte la sur-activité", () => {
    const now = Date.now();
    const trades = Array.from({ length: 40 }, (_, i) => ({ symbol: "SNTS", side: (i % 2 ? "sell" : "buy") as "buy" | "sell", quantity: 10, price: 22000, realizedPnl: i % 2 ? 100 : 0, ts: now - (40 - i) * 86_400_000 }));
    const profile = buildBehaviorProfile(declared, trades, [], []);
    expect(profile.biases.some((b) => b.code === "overtrading")).toBe(true);
    expect(profile.disciplineScore).toBeLessThan(80);
  });

  it("la recommandation propose une quantité compatible avec les liquidités", () => {
    const profile = buildBehaviorProfile(declared, [], [], []);
    const rec = recommend(analyze("SNTS", candles), { profile, positions: [], cash: 1_000_000 });
    expect(rec.suggestedAmount).toBeLessThanOrEqual(1_000_000);
    expect(rec.stopLoss).toBeLessThan(rec.price);
    expect(rec.targetPrice).toBeGreaterThan(rec.price);
    expect(["ACHAT FORT", "ACHAT", "CONSERVER", "ALLÉGER", "VENTE", "ÉVITER"]).toContain(rec.action);
  });

  it("le diagnostic de portefeuille signale l'excès de liquidités", () => {
    const profile = buildBehaviorProfile(declared, [], [], []);
    const d = diagnosePortfolio({ profile, positions: [{ symbol: "SNTS", quantity: 10, avgPrice: 20000, currentPrice: 22000, sector: "Télécommunications" }], cash: 5_000_000 }, new Map());
    expect(d.cashRatio).toBeGreaterThan(90);
    expect(d.suggestions.some((x) => x.includes("liquidités"))).toBe(true);
  });

  it("le backtest buy & hold reproduit la performance du titre", () => {
    const r = backtest("SNTS", candles, "buy_hold", 1_000_000);
    expect(r.trades).toBe(1);
    expect(Math.abs(r.totalReturnPct - r.buyHoldReturnPct)).toBeLessThan(3);
  });
});
