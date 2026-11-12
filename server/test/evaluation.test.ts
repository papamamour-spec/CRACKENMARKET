import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { DEFAULT_EVALUATION, evaluateObservations, evaluationDates, observeAt, reliability, spearman, strategyStats, walkForwardEvaluation, type Observation } from "../src/engine/evaluation.js";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../src/data/instruments.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { EvaluationService } from "../src/services/evaluation.js";
import { LearningService } from "../src/services/learning.js";
import type { Candle } from "../src/engine/indicators.js";

const DAY = 86_400_000;

function universe(n = 320, symbols = ["SNTS", "SGBC", "BOAB", "PALC", "ETIT", "SHEC"]): Map<string, Candle[]> {
  const end = new Date(Date.UTC(2026, 10, 10));
  return new Map(symbols.map((s, i) => [s, generateDailyHistory(INSTRUMENT_MAP.get(s)!, n, end, INSTRUMENT_MAP.get(s)!.refPrice, i + 1)]));
}

function indexFrom(u: Map<string, Candle[]>): Map<number, number> {
  const byTs = new Map<number, number[]>();
  for (const c of u.values()) for (const x of c) byTs.set(x.ts, [...(byTs.get(x.ts) ?? []), x.close / c[0].close]);
  return new Map([...byTs.entries()].map(([ts, v]) => [ts, (100 * v.reduce((a, b) => a + b, 0)) / v.length]));
}

describe("mesures d'évaluation", () => {
  it("corrélation de rang : parfaite, inverse, nulle, ex æquo", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBe(-1);
    expect(spearman([1, 2], [2, 1])).toBeNull();
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([1, 2, 2, 4], [1, 3, 3, 4])).toBeCloseTo(1, 6);
  });

  it("table de fiabilité et statistiques de stratégie", () => {
    const bins = reliability([{ probUp: 0.65, realizedPct: 1 }, { probUp: 0.62, realizedPct: -1 }, { probUp: 0.35, realizedPct: -2 }]);
    const b6 = bins.find((b) => b.from === 0.6)!;
    expect(b6.n).toBe(2);
    expect(b6.observed).toBe(0.5);
    expect(b6.predicted).toBeCloseTo(0.635, 3);
    expect(bins.find((b) => b.from === 0.3)!.observed).toBe(0);
    const s = strategyStats([{ ts: 1, retPct: 10 }, { ts: 2, retPct: -5 }, { ts: 3, retPct: 10 }], 21);
    expect(s.totalReturnPct).toBeCloseTo(15, 0);
    expect(s.maxDrawdownPct).toBe(5);
    expect(s.winShare).toBeCloseTo(0.67, 2);
    expect(s.curve).toHaveLength(4);
    expect(s.annualizedPct).toBeGreaterThan(s.totalReturnPct);
  });

  it("agrégation : prévision parfaite → IC 1, direction 100 %, stratégie nette de frais au-dessus du panier", () => {
    const obs: Observation[] = [];
    const syms = ["A", "B", "C", "D", "E", "F"];
    for (let d = 0; d < 6; d++) {
      syms.forEach((s, i) => {
        const realized = (i - 2.5) * 2 + (d % 2 ? 0.5 : -0.5); // −5,5 … +5,5, jamais nul
        obs.push({ ts: d * 10 * DAY, symbol: s, horizon: "1W", expectedPct: realized, probUp: realized > 0 ? 0.8 : 0.2, p5: realized - 5, p95: realized + 5, confidence: 0.5, realizedPct: realized });
      });
    }
    const [h] = evaluateObservations(obs, new Map(), { ...DEFAULT_EVALUATION, step: 10, topK: 2, feePct: 1, horizons: ["1W"] });
    expect(h.n).toBe(36);
    expect(h.hitRate).toBe(1);
    expect(h.ic.mean).toBe(1);
    expect(h.ic.positiveShare).toBe(1);
    expect(h.coverage90).toBe(1);
    expect(h.brier).toBeCloseTo(0.04, 3);
    expect(h.strategy.topK.periods).toBe(6);
    expect(h.strategy.topK.totalReturnPct).toBeGreaterThan(h.strategy.equalWeight.totalReturnPct);
    // premier rebalancement : panier entièrement renouvelé → 2 × 1 % de frais ; ensuite le panier est stable
    expect(h.strategy.costsPct).toBe(2);
    expect(h.strategy.index).toBeNull();
  });

  it("dates d'évaluation et absence de fuite du futur", () => {
    const u = universe(360);
    const cfg = { ...DEFAULT_EVALUATION, sessions: 100, step: 20, minHistory: 250 };
    const dates = evaluationDates(u, cfg);
    expect(dates.length).toBeGreaterThanOrEqual(1);
    expect(dates.length).toBeLessThanOrEqual(4);
    const idx = indexFrom(u);
    const snts = u.get("SNTS")!;
    const before = observeAt("SNTS", snts, idx, dates[0], cfg);
    // on perturbe les bougies postérieures à la date : la prévision ne doit pas bouger, le réalisé si
    const tampered = snts.map((c) => (c.ts > dates[0] ? { ...c, close: c.close * 1.5 } : c));
    const after = observeAt("SNTS", tampered, idx, dates[0], cfg);
    expect(after.map((o) => o.expectedPct)).toEqual(before.map((o) => o.expectedPct));
    expect(after[0].realizedPct).not.toBe(before[0].realizedPct);
    expect(observeAt("SNTS", snts.slice(-100), idx, dates[0], cfg)).toEqual([]);
  });

  it("rapport complet reproductible sur un petit univers", () => {
    const u = universe(330);
    const idx = indexFrom(u);
    const run = () => walkForwardEvaluation({ candlesBySymbol: u, indexByTs: idx, config: { sessions: 70, step: 7, minHistory: 250, topK: 2 } });
    const a = run();
    const b = run();
    expect(a.horizons.map((h) => h.horizon)).toEqual(["1W", "1M", "3M"]);
    for (const h of a.horizons) {
      expect(h.n).toBeGreaterThan(0);
      expect(h.hitRate).toBeGreaterThanOrEqual(0);
      expect(h.coverage90).toBeLessThanOrEqual(1);
      expect(h.reliability.reduce((s, r) => s + r.n, 0)).toBe(h.n);
      expect(h.strategy.index).not.toBeNull();
    }
    expect(b.horizons).toEqual(a.horizons); // même graine, mêmes données → même rapport
    expect(a.verdict).toHaveLength(3);
    expect(a.verdict[0]).toMatch(/^1W : direction/);
  });
});

describe("service d'évaluation et IC de l'apprentissage", () => {
  async function marketWithHistory(days: number): Promise<{ market: MarketService; db: ReturnType<typeof openMemoryDb> }> {
    const db = openMemoryDb();
    ensureHistoryDepth(db, days);
    const market = new MarketService(db);
    const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void; loadIndexBase(): void };
    await m.loadOrSeedHistory();
    for (const inst of INSTRUMENTS) m.initSnapshot(inst);
    m.loadIndexBase();
    return { market, db };
  }

  it("exécution en tâche de fond, rapport conservé, historique résumé", async () => {
    const { market, db } = await marketWithHistory(400);
    const svc = new EvaluationService(db, market);
    expect(svc.latest()).toBeNull();
    expect(svc.run({ sessions: 100, step: 20, topK: 3 })).toBe(true);
    expect(svc.run()).toBe(false); // déjà en cours
    expect(svc.status().running?.total).toBeGreaterThan(0);
    const report = await new Promise<import("../src/engine/evaluation.js").EvaluationReport>((resolve) => svc.once("report", resolve));
    expect(report.universe).toBe(INSTRUMENTS.length);
    expect(svc.status().running).toBeNull();
    expect(svc.latest()?.report.horizons).toHaveLength(3);
    const hist = svc.history();
    expect(hist).toHaveLength(1);
    expect(hist[0].horizons[0].ic).not.toBeUndefined();
    expect(svc.get(hist[0].id)?.report.config.topK).toBe(3);
  }, 60000);

  it("la boucle d'apprentissage expose la corrélation de rang par jour", async () => {
    const { market, db } = await marketWithHistory(400);
    const learning = new LearningService(db, market);
    const ins = db.prepare("INSERT INTO forecast_log(symbol, horizon, made_at, made_day, price, expected_pct, prob_up, p5, p95, ridge_pct, ar_pct, news_adj_pct, params_version, source, realized_pct, hit, abs_err, covered, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const syms = INSTRUMENTS.slice(0, 8).map((i) => i.symbol);
    for (const day of ["2026-09-01", "2026-09-08", "2026-09-15"]) {
      syms.forEach((s, i) => ins.run(s, "1W", Date.parse(day), day, 1000, i - 4, 0.5, -5, 5, 0, 0, 0, 0, "backfill", (i - 4) * (day === "2026-09-08" ? -1 : 1), 1, 0, 1, Date.now()));
    }
    const ic = learning.rankIC("1W");
    expect(ic.days).toBe(3);
    expect(ic.mean).toBeCloseTo(1 / 3, 3); // +1, −1, +1
    const s = learning.summary().byHorizon.find((h) => h.horizon === "1W")!;
    expect(s.rankIC).toBeCloseTo(0.333, 3);
    expect(s.rankICDays).toBe(3);
    expect(learning.summary().byHorizon.find((h) => h.horizon === "3M")!.rankIC).toBeNull();
  });
});
