import { describe, expect, it } from "vitest";
import { capWeights, cppiState, regimeAt, DEFAULT_CPPI } from "../src/engine/protection.js";
import { simulate, DEFAULT_SIM } from "../src/engine/stbacktest.js";
import type { BasketLine } from "../src/engine/metalabel.js";
import { openMemoryDb } from "../src/db/index.js";
import { INSTRUMENTS } from "../src/data/instruments.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { AuthService } from "../src/services/auth.js";
import { ForecastService } from "../src/services/forecast.js";
import { ShortTermService, type BacktestReport } from "../src/services/shortterm.js";
import type { AdvisorService } from "../src/services/advisor.js";

const DAY = 86_400_000;

describe("régime de marché", () => {
  const series = (f: (i: number) => number, n = 300) => Array.from({ length: n }, (_, i) => 100 * Math.exp(f(i)));
  it("haussier quand l'indice monte au-dessus de ses moyennes, baissier quand il baisse sous la 50, neutre sinon", () => {
    const up = series((i) => 0.001 * i + 0.002 * Math.sin(i));
    expect(regimeAt(up, up.length - 1).key).toBe("haussier");
    const down = series((i) => -0.001 * i + 0.002 * Math.sin(i));
    const r = regimeAt(down, down.length - 1);
    expect(["baissier", "stress"]).toContain(r.key);
    const flat = series((i) => 0.003 * Math.sin(i / 3));
    expect(regimeAt(flat, flat.length - 1).key).toBe("neutre");
  });
  it("stress quand la volatilité s'emballe ou que le repli dépasse 15 % ; neutre avec un historique court", () => {
    const calm = series((i) => 0.0005 * i + 0.001 * Math.sin(i));
    const shocked = calm.map((v, i) => (i >= calm.length - 15 ? v * Math.exp(0.05 * ((i % 2) * 2 - 1)) : v));
    expect(regimeAt(shocked, shocked.length - 1).key).toBe("stress");
    const crash = calm.map((v, i) => (i >= calm.length - 40 ? v * 0.8 : v));
    expect(regimeAt(crash, crash.length - 1).key).toBe("stress");
    expect(regimeAt(crash.slice(0, 50), 49)).toMatchObject({ key: "neutre", multiplier: 0.75 });
  });
});

describe("CPPI à plancher cliquet", () => {
  it("coussin × multiplicateur borné à 100 %, plancher qui ne redescend jamais, régime qui réduit", () => {
    const s0 = cppiState(100, 100);
    expect(s0.floor).toBe(85);
    expect(s0.rawExposure).toBeCloseTo(0.6, 6);
    expect(s0.exposure).toBeCloseTo(0.6, 6);
    expect(cppiState(110, 100).peak).toBe(110); // le plus haut suit la valeur (cliquet)
    expect(cppiState(110, 100, 1, { ...DEFAULT_CPPI, multiplier: 8 }).exposure).toBe(1); // coussin 16,5 × 8 > 100 % : borné
    const after = cppiState(95, 110); // plus haut 110 → plancher 93,5 ; coussin 1,5 → 6 %
    expect(after.floor).toBeCloseTo(93.5, 6);
    expect(after.exposure).toBeCloseTo(0.063, 3);
    expect(cppiState(90, 110).exposure).toBe(0); // sous le plancher : tout en liquidités
    expect(cppiState(100, 100, 0.5).exposure).toBeCloseTo(0.3, 6);
    expect(cppiState(100, 100, 1, { ...DEFAULT_CPPI, floorPct: 0.8 }).exposure).toBeCloseTo(0.8, 6);
  });
  it("plafonnement proportionnel des poids", () => {
    const lines = [{ symbol: "A", weightPct: 20 }, { symbol: "B", weightPct: 20 }, { symbol: "C", weightPct: 10 }];
    expect(capWeights(lines, 25).map((l) => l.weightPct)).toEqual([10, 10, 5]);
    expect(capWeights(lines, 60)).toEqual(lines);
  });
});

describe("simulateur du moteur court terme", () => {
  function world(n = 120) {
    const timeline = Array.from({ length: n }, (_, i) => Date.UTC(2026, 0, 5) + i * DAY);
    const mk = (f: (i: number) => number) => new Map(timeline.map((ts, i) => [ts, f(i)]));
    const closes = new Map<string, Map<number, number>>([
      ["UP", mk((i) => 100 * (1 + 0.004 * i))], // monte régulièrement : touche l'objectif
      ["DOWN", mk((i) => 100 * (1 - 0.004 * i))], // baisse : touche le seuil
      ["FLAT", mk(() => 100)], // ne bouge pas : échéance
    ]);
    const index = mk((i) => 100 + 0.1 * i);
    const line = (symbol: string, prob: number): BasketLine => ({ symbol, price: 100, prob, expectedPct: 2, barriers: { profit: 0.08, stop: 0.05, maxSessions: 30 }, liquidityCap: 1, kelly: 0.3, weightPct: 30 });
    return { timeline, closes, index, line };
  }
  it("barrières, frais, statistiques : objectif, seuil, échéance, puis clôture finale", () => {
    const { timeline, closes, index, line } = world();
    const proposals = new Map([[timeline[0], [line("UP", 0.7), line("DOWN", 0.6), line("FLAT", 0.65)]]]);
    const r = simulate({ timeline, closes, index, proposals, config: { ...DEFAULT_SIM, capital: 1_000_000, feeRate: 0.01, protection: false, regime: false } });
    const sells = r.trades.filter((t) => t.side === "vente");
    expect(sells.map((t) => t.reason).sort()).toEqual(["objectif", "seuil", "échéance"]);
    expect(sells.find((t) => t.symbol === "UP")!.retPct).toBeGreaterThan(5);
    expect(sells.find((t) => t.symbol === "DOWN")!.retPct).toBeLessThan(-5);
    expect(r.stats.trades).toBe(3);
    expect(r.stats.wins).toBe(1);
    expect(r.stats.feesPct).toBeGreaterThan(0);
    expect(r.series).toHaveLength(timeline.length);
    expect(r.series[0].exposurePct).toBeGreaterThan(80);
    expect(Math.abs(r.series[r.series.length - 1].value - 1_000_000 * (1 + r.stats.totalReturnPct / 100))).toBeLessThan(100);
    expect(r.stats.avgExposurePct).toBeLessThan(90); // tout est soldé avant la fin
  });
  it("protection : l'exposition est bornée par le coussin, la désexposition solde d'abord les lignes les moins probables", () => {
    const { timeline, closes, index, line } = world();
    const crashing = new Map(closes);
    crashing.set("DOWN", new Map(timeline.map((ts, i) => [ts, 100 * (1 - 0.003 * i)])));
    crashing.set("FLAT", new Map(timeline.map((ts, i) => [ts, 100 * (1 - 0.003 * i)])));
    crashing.set("UP", new Map(timeline.map((ts, i) => [ts, 100 * (1 - 0.003 * i)])));
    const proposals = new Map([[timeline[0], [line("UP", 0.7), line("DOWN", 0.6), line("FLAT", 0.65)]]]);
    const r = simulate({ timeline, closes: crashing, index, proposals, config: { ...DEFAULT_SIM, capital: 1_000_000, feeRate: 0.01, protection: true, regime: false, cppi: { floorPct: 0.9, multiplier: 4, maxExposure: 1 } } });
    expect(r.series[0].exposurePct).toBeLessThanOrEqual(40); // coussin 10 % × 4
    const prot = r.trades.filter((t) => t.reason === "protection");
    expect(prot.length).toBeGreaterThan(0);
    expect(prot[0].symbol).toBe("DOWN"); // la moins probable d'abord
    expect(Math.min(...r.series.map((s) => s.value))).toBeGreaterThan(1_000_000 * 0.88); // le plancher tient (frais compris)
    const sans = simulate({ timeline, closes: crashing, index, proposals, config: { ...DEFAULT_SIM, capital: 1_000_000, feeRate: 0.01, protection: false, regime: false } });
    expect(r.stats.maxDrawdownPct).toBeGreaterThan(sans.stats.maxDrawdownPct);
  });
  it("rotation : les lignes proposées non détenues sont ouvertes dans la limite du plafond", () => {
    const { timeline, closes, index, line } = world();
    const proposals = new Map([[timeline[0], [line("UP", 0.7)]], [timeline[10], [line("UP", 0.7), line("FLAT", 0.65)]]]);
    const r = simulate({ timeline, closes, index, proposals, config: { ...DEFAULT_SIM, capital: 1_000_000, feeRate: 0.01, protection: false, regime: false } });
    const buys = r.trades.filter((t) => t.side === "achat");
    expect(buys.map((t) => t.symbol)).toEqual(["UP", "FLAT"]);
    expect(buys[1].ts).toBe(timeline[10]);
  });
});

describe("service court terme : protection et mesure complète", () => {
  async function setup() {
    const db = openMemoryDb();
    ensureHistoryDepth(db, 520);
    const market = new MarketService(db);
    const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void; loadIndexBase(): void };
    await m.loadOrSeedHistory();
    for (const inst of INSTRUMENTS) m.initSnapshot(inst);
    m.loadIndexBase();
    const forecasts = new ForecastService(market, { newsContext: () => new Map() } as unknown as AdvisorService);
    const svc = new ShortTermService(db, market, forecasts);
    const userId = new AuthService(db).register("ct3@cm.test", "Secret123", "Court terme").id;
    return { db, market, svc, userId };
  }

  it("le panier publié est borné par l'exposition autorisée ; la revue applique la protection", async () => {
    const { svc, userId } = await setup();
    svc.trainSync({ sessions: 160, step: 20, minHistory: 250, panel: false });
    const c = svc.candidates(5_000_000);
    expect(c.protection.regime.key).toBeDefined();
    expect(c.protection.exposure).toBeLessThanOrEqual(1);
    const total = c.items.filter((x) => x.selected).reduce((a, x) => a + x.weightPct, 0);
    expect(total).toBeLessThanOrEqual(c.protection.exposure * 100 + 0.2);
    expect(c.cashPct).toBeCloseTo(100 - total, 0);
    if (!c.items.some((x) => x.selected)) return;
    const p = svc.publish(userId, 5_000_000);
    expect(p.protection).not.toBeNull();
    expect(p.protection!.state.peak).toBe(5_000_000);
    expect(p.protection!.state.floor).toBeCloseTo(5_000_000 * 0.85, 0);
    const r = svc.review();
    expect(r.reviewed).toBe(1);
    expect(svc.view(userId, p.id)!.status).toBe("actif"); // un portefeuille protégé reste actif en liquidités
    expect(svc.status().regime.key).toBe(c.protection.regime.key);
  }, 120000);

  it("mesure complète hors échantillon : entraînement sur la première partie, simulation sur la suite, deux variantes et l'indice", async () => {
    const { svc } = await setup();
    expect(svc.latestBacktest()).toBeNull();
    expect(svc.backtest({ sessions: 200, step: 10, minHistory: 250, panel: false, rotation: 5 })).toBe(true);
    expect(svc.backtest()).toBe(false); // déjà en cours
    expect(svc.status().backtesting?.total).toBeGreaterThan(0);
    const report = await new Promise<BacktestReport>((resolve) => svc.once("backtest", resolve));
    expect(report.train.dates).toBeGreaterThanOrEqual(6);
    expect(report.train.to).toBeLessThan(report.test.from);
    expect(report.test.sessions).toBeGreaterThanOrEqual(30);
    expect(report.variants.complete.series).toHaveLength(report.test.sessions);
    expect(report.variants.sansProtection.series).toHaveLength(report.test.sessions);
    expect(report.variants.complete.stats.avgExposurePct).toBeLessThanOrEqual(100);
    expect(Number.isFinite(report.index.totalReturnPct)).toBe(true);
    expect(report.verdict.length).toBe(4);
    expect(svc.latestBacktest()?.id).toBe(report.id);
    expect(svc.status().latestBacktest?.complete.sessions).toBe(report.test.sessions);
    expect(svc.status().backtesting).toBeNull();
  }, 180000);
});
