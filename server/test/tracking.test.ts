import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { INSTRUMENTS } from "../src/data/instruments.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { AuthService } from "../src/services/auth.js";
import { TrackingService } from "../src/services/tracking.js";

async function setup() {
  const db = openMemoryDb();
  ensureHistoryDepth(db, 120);
  const market = new MarketService(db);
  const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void };
  await m.loadOrSeedHistory();
  for (const inst of INSTRUMENTS) m.initSnapshot(inst);
  const auth = new AuthService(db);
  const user = auth.register("suivi@cm.test", "Suivi12345", "Suivi");
  return { db, market, userId: user.id };
}

describe("suivi des portefeuilles recommandés", () => {
  it("fige un portefeuille au cours du jour, déduit les frais et le valorise contre les indices", async () => {
    const { db, market, userId } = await setup();
    const svc = new TrackingService(db, market);
    const v = svc.create(userId, { kind: "conseil", label: "Conseil du jour", capital: 5_000_000, lines: [{ symbol: "SNTS", weightPct: 40 }, { symbol: "ORAC", weightPct: 30 }, { symbol: "XXXX", weightPct: 10 }] });
    expect(v.lines.map((l) => l.symbol)).toEqual(["SNTS", "ORAC"]);
    expect(v.entryCost).toBeGreaterThan(0);
    const invested = v.lines.reduce((a, l) => a + l.amount, 0);
    expect(v.cash).toBeCloseTo(5_000_000 - invested - v.entryCost, 0);
    expect(v.stats.sessions).toBeGreaterThanOrEqual(1);
    // le jour même : valeur = capital − frais d'entrée, net de sortie encore un peu plus bas
    expect(v.stats.value).toBeCloseTo(5_000_000 - v.entryCost, -2);
    expect(v.stats.valueNet).toBeLessThan(v.stats.value);
    expect(v.stats.returnNetPct).toBeLessThan(0);
    expect(v.series[0]).toMatchObject({ benchmarkPct: 0, brvm30Pct: 0 });
    const list = svc.list(userId);
    expect(list).toHaveLength(1);
    expect(list[0].stats.alphaCompositePct).toBeCloseTo(list[0].stats.returnNetPct - list[0].stats.compositePct, 6);
    expect(svc.view(userId + 1, v.id)).toBeNull();
    expect(svc.remove(userId, v.id)).toBe(true);
    expect(svc.list(userId)).toHaveLength(0);
  });
  it("refuse un capital nul ou des lignes invalorisables", async () => {
    const { db, market, userId } = await setup();
    const svc = new TrackingService(db, market);
    expect(() => svc.create(userId, { kind: "manuel", label: "x", capital: 0, lines: [{ symbol: "SNTS", weightPct: 50 }] })).toThrow(/Capital/);
    expect(() => svc.create(userId, { kind: "manuel", label: "x", capital: 1000, lines: [{ symbol: "ORAC", weightPct: 50 }] })).toThrow(/Aucune ligne/);
  });
});
