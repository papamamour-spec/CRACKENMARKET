import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { LearningService } from "../src/services/learning.js";
import { forecast, DEFAULT_PARAMS } from "../src/engine/forecast.js";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { INSTRUMENT_MAP } from "../src/data/instruments.js";
import type { MarketService } from "../src/services/market.js";

const inst = INSTRUMENT_MAP.get("SNTS")!;
const full = generateDailyHistory(inst, 700);
const market = { history: (_s: string, n: number) => full.slice(-n) } as unknown as MarketService;

describe("apprentissage continu", () => {
  it("journalise, résout avec le cours constaté et recalibre les paramètres", () => {
    const db = openMemoryDb();
    const svc = new LearningService(db, market);
    // 30 prévisions « comme à l'époque », une toutes les 5 séances, entre 200 et 50 séances avant la fin
    let logged = 0;
    for (let back = 200; back >= 50; back -= 5) {
      const candles = full.slice(0, full.length - back);
      const f = forecast({ symbol: "SNTS", candles, params: svc.params("SNTS"), seed: back });
      logged += svc.log(f, candles[candles.length - 1].ts, "backfill");
    }
    expect(logged).toBe(31 * 3);
    const n = svc.resolveDue();
    expect(n).toBe(31 * 3 - 3); // les 3 prévisions à 3 mois émises à moins de 63 séances de la fin restent ouvertes
  });
  it("ne résout que les horizons atteints et met à jour les statistiques réelles", () => {
    const db = openMemoryDb();
    const svc = new LearningService(db, market);
    for (let back = 200; back >= 30; back -= 5) {
      const candles = full.slice(0, full.length - back);
      const f = forecast({ symbol: "SNTS", candles, params: svc.params("SNTS"), seed: back });
      svc.log(f, candles[candles.length - 1].ts, "backfill");
    }
    const n = svc.resolveDue();
    const s = svc.summary();
    expect(n).toBe(s.totalResolved);
    const h3 = s.byHorizon.find((h) => h.horizon === "3M")!;
    const h1 = s.byHorizon.find((h) => h.horizon === "1W")!;
    expect(h3.pending).toBeGreaterThan(0); // les plus récentes (< 63 séances) attendent
    expect(h1.pending).toBe(0); // toutes émises à ≥ 30 séances de la fin
    expect(h1.resolved).toBeGreaterThan(h3.resolved);
    expect(h1.hitRate).not.toBeNull();
    expect(h1.coverage90).not.toBeNull();
    const p = svc.params("SNTS")["1W"];
    expect(p.resolved).toBe(h1.resolved);
    expect(p.version).toBeGreaterThan(0);
    expect(p.modelErr.ridge).not.toBeNull();
    expect(Math.abs(p.bias)).toBeLessThanOrEqual(5);
    // une deuxième résolution ne change rien (idempotence)
    expect(svc.resolveDue()).toBe(0);
    // la prévision suivante utilise les paramètres appris
    const f = forecast({ symbol: "SNTS", candles: full, params: svc.params("SNTS") });
    expect(f.horizons[0].learning.version).toBe(p.version);
    expect(f.horizons[0].learning.resolved).toBe(p.resolved);
    expect(f.horizons[0].explanations.some((e) => e.includes("En conditions réelles"))).toBe(true);
  });
  it("élargit les intervalles quand ils sont trop souvent dépassés", () => {
    const db = openMemoryDb();
    const svc = new LearningService(db, market);
    // prévisions artificielles à intervalle très étroit : la couverture réelle sera mauvaise
    const ins = db.prepare("INSERT INTO forecast_log(symbol, horizon, made_at, made_day, price, expected_pct, prob_up, p5, p95, ridge_pct, ar_pct, news_adj_pct) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    for (let back = 300; back >= 40; back -= 5) {
      const c = full[full.length - back];
      ins.run("SNTS", "1M", c.ts, new Date(c.ts).toISOString().slice(0, 10), c.close, 0, 0.5, -0.1, 0.1, 0, 0, 0);
    }
    svc.resolveDue();
    const p = svc.params("SNTS")["1M"];
    expect(p.resolved).toBeGreaterThan(20);
    expect(p.volScale).toBeGreaterThan(1);
    expect(svc.summary().byHorizon.find((h) => h.horizon === "1M")!.coverage90).toBeLessThan(0.5);
  });
  it("renforce le poids de l'actualité seulement quand elle réduit l'erreur", () => {
    const db = openMemoryDb();
    const svc = new LearningService(db, market);
    const ins = db.prepare("INSERT INTO forecast_log(symbol, horizon, made_at, made_day, price, expected_pct, prob_up, p5, p95, ridge_pct, ar_pct, news_adj_pct) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    // ajustement d'actualité toujours dans le bon sens (expected = réalisé exact via un gros news_adj)
    for (let back = 200; back >= 40; back -= 5) {
      const c = full[full.length - back];
      const realized = ((full[full.length - back + 21].close - c.close) / c.close) * 100;
      ins.run("SNTS", "1M", c.ts, new Date(c.ts).toISOString().slice(0, 10), c.close, realized, 0.5, -30, 30, 0, 0, realized);
    }
    svc.resolveDue();
    expect(svc.params("SNTS")["1M"].newsFactor).toBeGreaterThan(DEFAULT_PARAMS.newsFactor);
  });
  it("rechoisit la régularisation par validation", () => {
    const db = openMemoryDb();
    const svc = new LearningService(db, market);
    const best = svc.tuneLambda("SNTS", true);
    expect(best).not.toBeNull();
    expect([1, 5, 20, 60]).toContain(best!.lambda);
    expect(svc.params("SNTS")["1M"].lambda).toBe(best!.lambda);
  });
});
