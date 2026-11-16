import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { INSTRUMENTS } from "../src/data/instruments.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { AuthService } from "../src/services/auth.js";
import { ForecastService } from "../src/services/forecast.js";
import { ShortTermService } from "../src/services/shortterm.js";
import { TodayService } from "../src/services/today.js";
import type { AdvisorService } from "../src/services/advisor.js";

async function setup() {
  const db = openMemoryDb();
  ensureHistoryDepth(db, 520);
  const market = new MarketService(db);
  const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void; loadIndexBase(): void };
  await m.loadOrSeedHistory();
  for (const inst of INSTRUMENTS) m.initSnapshot(inst);
  m.loadIndexBase();
  const forecasts = new ForecastService(market, { newsContext: () => new Map() } as unknown as AdvisorService);
  const shortTerm = new ShortTermService(db, market, forecasts);
  const today = new TodayService(db, market, shortTerm);
  const userId = new AuthService(db).register("today@cm.test", "Secret123", "Aujourd'hui").id;
  return { db, market, shortTerm, today, userId };
}

const fakeBacktest = (db: ReturnType<typeof openMemoryDb>, completePct: number, completeDd: number, indexPct: number, indexDd: number, createdAt = Date.now()) => {
  const stats = (t: number, d: number) => ({ sessions: 150, totalReturnPct: t, annualizedPct: null, maxDrawdownPct: d, volatilityPct: 10, sharpe: 0.5, trades: 10, wins: 5, losses: 5, winRate: 0.5, avgTradeReturnPct: 0.5, avgHoldingSessions: 20, avgExposurePct: 40, cashShare: 0.2, feesPct: 1, exits: {} });
  const report = { createdAt, config: {}, train: { from: 1, to: 2, dates: 8, stats: {} }, test: { from: 3, to: 4, sessions: 150, rotations: 30 }, variants: { complete: { series: [], trades: [], stats: stats(completePct, completeDd) }, sansProtection: { series: [], trades: [], stats: stats(completePct - 2, completeDd - 3) } }, index: { totalReturnPct: indexPct, maxDrawdownPct: indexDd }, verdict: ["x"] };
  db.prepare("INSERT INTO st_backtests(created_at, config, report) VALUES (?,?,?)").run(createdAt, "{}", JSON.stringify(report));
};

describe("Aujourd'hui", () => {
  it("sans modèle ni mesure : feu orange, rien à faire ou une proposition de panier, capital vide", async () => {
    const { today, userId } = await setup();
    const v = today.view(userId);
    expect(v.health.light).toBe("orange");
    expect(v.health.reasons.join(" ")).toMatch(/pas encore été mesuré/);
    expect(v.health.reasons.join(" ")).toMatch(/pas encore entraîné/);
    expect(v.capital.shortTerm).toBeNull();
    expect(v.capital.total).toBe(0);
    expect(v.actions.every((a) => a.kind === "info")).toBe(true);
    expect(v.nextReview).toMatch(/clôture/);
  }, 120000);

  it("feu vert quand la mesure bat l'indice avec une perte moindre ; rouge quand elle ne le bat pas ; orange si ancienne", async () => {
    const { db, today, userId, shortTerm } = await setup();
    shortTerm.trainSync({ sessions: 160, step: 20, minHistory: 250, panel: false });
    fakeBacktest(db, 8, -5, 3, -9);
    expect(today.view(userId).health.light).toBe("vert");
    fakeBacktest(db, 8, -12, 3, -9);
    const o = today.view(userId).health;
    expect(o.light).toBe("orange");
    expect(o.reasons.join(" ")).toMatch(/perte maximale plus forte/);
    fakeBacktest(db, 1, -5, 3, -9);
    const r = today.view(userId).health;
    expect(r.light).toBe("rouge");
    expect(r.title).toMatch(/pas assez bon/);
    expect(today.view(userId).actions.some((a) => a.kind === "info")).toBe(false); // pas de proposition de panier au rouge
    fakeBacktest(db, 8, -5, 3, -9, Date.now() - 60 * 86_400_000);
    const old = today.view(userId).health;
    expect(old.light).toBe("orange");
    expect(old.reasons.join(" ")).toMatch(/à refaire chaque mois/);
  }, 120000);

  it("portefeuille court terme : ordres d'achat en phrases, rapprochement, vente après barrière, capital et jauge", async () => {
    const { db, today, userId, shortTerm, market } = await setup();
    shortTerm.trainSync({ sessions: 160, step: 20, minHistory: 250, panel: false });
    fakeBacktest(db, 8, -5, 3, -9);
    const c = shortTerm.candidates(5_000_000);
    if (!c.items.some((x) => x.selected)) return; // panier vide sur cet historique : rien à rapprocher
    const p = shortTerm.publish(userId, 5_000_000);
    let v = today.view(userId);
    const buys = v.actions.filter((a) => a.kind === "acheter");
    expect(buys).toHaveLength(p.positions.length);
    expect(buys[0].text).toMatch(/^Acheter \d/);
    expect(buys[0].why).toMatch(/objectif/);
    expect(buys[0].details.join(" ")).toMatch(/Échéance/);
    expect(v.capital.shortTerm).toMatchObject({ portfolioId: p.id, capital: 5_000_000, open: p.positions.length });
    expect(v.capital.shortTerm!.exposureCapPct).toBeGreaterThan(0);
    expect(v.capital.total).toBe(v.capital.shortTerm!.value);
    // rapprochement
    expect(today.confirm(userId, buys[0].positionId!, "achat")).toBe(true);
    expect(today.confirm(userId + 1, buys[0].positionId!, "achat")).toBe(false);
    v = today.view(userId);
    expect(v.actions.filter((a) => a.kind === "acheter")).toHaveLength(p.positions.length - 1);
    // l'objectif est touché : la ligne soldée devient un ordre de vente
    const pos = p.positions[0];
    (market as unknown as { candles: Map<string, { ts: number; open: number; high: number; low: number; close: number; volume: number }[]> }).candles.get(pos.symbol)!.push({ ts: p.startTs + 3 * 86_400_000, open: pos.targetPrice, high: pos.targetPrice, low: pos.targetPrice, close: pos.targetPrice, volume: 1000 });
    shortTerm.review();
    v = today.view(userId);
    const sell = v.actions.find((a) => a.kind === "vendre" && a.positionId === pos.id)!;
    expect(sell).toBeDefined();
    expect(sell.text).toMatch(/^Vendre \d/);
    expect(sell.why).toMatch(/objectif a été touché/);
    expect(today.confirm(userId, pos.id, "vente")).toBe(true);
    expect(today.view(userId).actions.some((a) => a.id === sell.id)).toBe(false);
  }, 120000);
});
