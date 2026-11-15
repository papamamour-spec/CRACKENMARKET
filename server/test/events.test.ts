import { describe, expect, it } from "vitest";
import { bookPressure, dividendWindow, equalWeightMarket, postPublicationDrift, residualMomentum, surpriseFrom, EVENT_SIGNALS } from "../src/engine/events.js";
import { panelModel, PANEL_FACTORS } from "../src/engine/panel.js";
import { evaluateObservations, walkForwardEvaluation, type Observation } from "../src/engine/evaluation.js";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../src/data/instruments.js";
import { openMemoryDb } from "../src/db/index.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { FundamentalsService } from "../src/services/fundamentals.js";
import { CorporateService } from "../src/services/corporate.js";
import { BocService } from "../src/services/boc.js";
import { PanelService } from "../src/services/panel.js";
import type { Candle } from "../src/engine/indicators.js";

const DAY = 86_400_000;
const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

function universe(n = 500, symbols = ["SNTS", "SGBC", "BOAB", "PALC", "ETIT", "SHEC", "ORAC", "CIEC"]): Map<string, Candle[]> {
  const end = new Date(Date.UTC(2026, 10, 10));
  return new Map(symbols.map((s, i) => [s, generateDailyHistory(INSTRUMENT_MAP.get(s)!, n, end, INSTRUMENT_MAP.get(s)!.refPrice, i + 3)]));
}

describe("signaux événementiels (moteur)", () => {
  it("surprise : résultat et dividende saturent à ±40 %, pondérés 0,6 / 0,4", () => {
    expect(surpriseFrom(20, null)).toBeCloseTo(0.5, 6);
    expect(surpriseFrom(null, -80)).toBe(-1);
    expect(surpriseFrom(40, 40)).toBeCloseTo(1, 6);
    expect(surpriseFrom(20, -20)).toBeCloseTo(0.6 * 0.5 - 0.4 * 0.5, 6);
    expect(surpriseFrom(null, null)).toBeNull();
  });

  it("dérive post-publication : dernière publication connue, amortie sur 60 jours, jamais lue avant sa date", () => {
    const pubs = [{ ts: utc(2026, 3, 1), surprise: 0.8 }, { ts: utc(2026, 9, 1), surprise: -0.5 }];
    expect(postPublicationDrift(pubs, utc(2026, 2, 28))).toBe(0);
    expect(postPublicationDrift(pubs, utc(2026, 3, 1))).toBeCloseTo(0.8, 6);
    expect(postPublicationDrift(pubs, utc(2026, 3, 31))).toBeCloseTo(0.8 * 0.5, 6);
    expect(postPublicationDrift(pubs, utc(2026, 6, 1))).toBe(0);
    expect(postPublicationDrift(pubs, utc(2026, 9, 11))).toBeCloseTo(-0.5 * (1 - 10 / 60), 6);
  });

  it("fenêtre de dividende : 0 → 1 avant le détachement, −1 → 0 après, 0 hors fenêtre", () => {
    const divs = [{ exDate: utc(2026, 5, 20) }];
    expect(dividendWindow(divs, utc(2026, 3, 1))).toBe(0);
    expect(dividendWindow(divs, utc(2026, 4, 20))).toBe(0);
    expect(dividendWindow(divs, utc(2026, 5, 5))).toBeCloseTo(0.5, 6);
    expect(dividendWindow(divs, utc(2026, 5, 19))).toBeCloseTo(1 - 1 / 30, 6);
    expect(dividendWindow(divs, utc(2026, 5, 20))).toBeCloseTo(-1, 6);
    expect(dividendWindow(divs, utc(2026, 5, 25))).toBeCloseTo(-0.5, 6);
    expect(dividendWindow(divs, utc(2026, 5, 30))).toBe(0);
  });

  it("pression du carnet : déséquilibre moyen des 5 dernières séances connues et réservations, 0 sans bulletin", () => {
    const t0 = utc(2026, 10, 1);
    const sessions = Array.from({ length: 8 }, (_, i) => ({ ts: t0 + i * DAY, imbalance: i < 3 ? -1 : 0.5, reserved: (i === 7 ? "up" : null) as "up" | null }));
    expect(bookPressure(sessions, t0 + 7 * DAY)).toBeCloseTo(0.5 + 0.2, 6); // 5 dernières : toutes à +0,5, une réservation à la hausse
    expect(bookPressure(sessions, t0 + 2 * DAY)).toBeCloseTo(-1, 6);
    expect(bookPressure(sessions, t0 + 40 * DAY)).toBe(0); // bulletins trop anciens
    expect(bookPressure([], t0)).toBe(0);
  });

  it("momentum résiduel : positif pour une valeur qui bat durablement le marché, nul avec un historique court, borné à ±3", () => {
    const n = 400;
    const noise = (i: number) => 0.004 * Math.sin(i * 1.7) + 0.003 * Math.cos(i * 0.37);
    const market = Array.from({ length: n }, (_, i) => 100 * Math.exp(0.0003 * i + 0.01 * Math.sin(i / 7)));
    const strong = market.map((m, i) => m * Math.exp(0.0012 * i + noise(i)));
    const beta2 = market.map((m, i) => 100 * (m / 100) ** 2 * Math.exp(noise(i))); // exposition double au marché, sans tendance propre
    expect(residualMomentum(strong, market, n - 1)).toBeGreaterThan(1);
    expect(residualMomentum(strong, market, n - 1)).toBeLessThanOrEqual(3);
    expect(Math.abs(residualMomentum(beta2, market, n - 1))).toBeLessThan(0.5);
    expect(residualMomentum(strong.slice(0, 100), market.slice(0, 100), 99)).toBe(0);
    // le dernier mois est exclu : un bond sur les 21 dernières séances ne change pas le signal
    const jump = strong.map((c, i) => (i >= n - 15 ? c * 1.3 : c));
    expect(residualMomentum(jump, market, n - 1)).toBeCloseTo(residualMomentum(strong, market, n - 1), 10);
  });

  it("marché équipondéré : moyenne des rendements des valeurs présentes aux deux dates", () => {
    const tl = [1, 2, 3];
    const a = new Map([[1, 100], [2, 110], [3, 110]]);
    const b = new Map([[1, 50], [2, 50], [3, 55]]);
    const m = equalWeightMarket(tl, [a, b]);
    expect(m[0]).toBe(100);
    expect(m[1]).toBeCloseTo(100 * Math.exp(Math.log(1.1) / 2), 8);
    expect(m[2]).toBeCloseTo(m[1] * Math.exp(Math.log(1.1) / 2), 8);
  });
});

describe("signaux événementiels dans le panel et l'évaluation", () => {
  it("le panel expose les quatre signaux comme facteurs et lit les extras datés", () => {
    expect(PANEL_FACTORS.slice(-4).map((f) => f.key)).toEqual(EVENT_SIGNALS.map((s) => s.key));
    const u = universe(500);
    const calls: number[] = [];
    const r = panelModel(u, null, { lookback: 400, extrasAt: (symbol, ts) => { calls.push(ts); return { dividendYieldPct: 4, earningsYieldPct: 8, daysToExDividend: null, pubDrift: symbol === "SNTS" ? 0.7 : 0, divWindow: 0, book5: 0 }; } });
    expect(calls.length).toBeGreaterThan(100);
    const c = r.predictions.get("SNTS")!["1M"]!.contributions;
    expect(c).toHaveLength(PANEL_FACTORS.length);
    expect(c.find((x) => x.factor === "pubDrift")!.value).toBe(0.7);
    expect(Number.isFinite(c.find((x) => x.factor === "resMom")!.value)).toBe(true);
    expect(c.some((x) => x.factor === "resMom" && x.value !== 0)).toBe(true);
  });

  it("l'évaluation mesure la corrélation de rang de chaque famille, sur les seules dates où elle varie", () => {
    const obs: Observation[] = [];
    const syms = ["A", "B", "C", "D", "E", "F"];
    for (let d = 0; d < 6; d++) {
      syms.forEach((s, i) => {
        const realized = (i - 2.5) * (d === 3 ? -1 : 1);
        obs.push({ ts: 1000 + d, symbol: s, horizon: "1M", expectedPct: 0, probUp: 0.5, p5: -5, p95: 5, confidence: 0.5, realizedPct: realized, signals: { pubDrift: d < 2 ? 0 : i, divWindow: 0, book5: -i, resMom: i } });
      });
    }
    const [h] = evaluateObservations(obs, new Map(), { sessions: 100, step: 10, topK: 2, feePct: 1, minHistory: 10, horizons: ["1M"], seed: 1, panel: false });
    const sig = Object.fromEntries(h.signals!.map((s) => [s.key, s]));
    expect(sig.resMom.ic.dates).toBe(6);
    expect(sig.resMom.ic.mean).toBeCloseTo(4 / 6, 3); // +1 cinq fois, −1 une fois
    expect(sig.book5.ic.mean).toBeCloseTo(-4 / 6, 3);
    expect(sig.pubDrift.ic.dates).toBe(4); // deux dates sans variation du signal ignorées
    expect(sig.divWindow.ic.mean).toBeNull();
    expect(sig.divWindow.activeShare).toBe(0);
    expect(sig.resMom.activeShare).toBeCloseTo(0.83, 2);
  });

  it("marche avant : les signaux sont relevés à chaque date sans lire le futur et figurent dans le verdict", () => {
    const u = universe(420, ["SNTS", "SGBC", "BOAB", "PALC", "ETIT", "SHEC"]);
    const idx = new Map<number, number>();
    for (const c of u.get("SNTS")!) idx.set(c.ts, c.close);
    const seen: number[] = [];
    const rep = walkForwardEvaluation({ candlesBySymbol: u, indexByTs: idx, config: { sessions: 120, step: 20, minHistory: 300, horizons: ["1M"], panel: false }, extrasAt: (_s, ts) => { seen.push(ts); return { dividendYieldPct: null, earningsYieldPct: null, daysToExDividend: null, pubDrift: 0.3, divWindow: 0, book5: 0 }; } });
    const h = rep.horizons[0];
    expect(h.signals!.map((s) => s.key)).toEqual(EVENT_SIGNALS.map((s) => s.key));
    expect(h.signals!.find((s) => s.key === "resMom")!.ic.dates).toBeGreaterThan(0);
    expect(seen.every((ts) => ts <= rep.lastDate!)).toBe(true);
    expect(rep.verdict[0]).toMatch(/signaux : .*momentum résiduel/);
  });
});

describe("service du panel : extras événementiels datés", () => {
  async function setup() {
    const db = openMemoryDb();
    ensureHistoryDepth(db, 120);
    const market = new MarketService(db);
    const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void };
    await m.loadOrSeedHistory();
    for (const inst of INSTRUMENTS) m.initSnapshot(inst);
    const fundamentals = new FundamentalsService(db, market);
    const corporate = new CorporateService(db, market);
    const boc = new BocService(db, market);
    const panel = new PanelService(market);
    panel.attach(corporate, fundamentals, boc);
    return { db, market, fundamentals, corporate, boc, panel };
  }

  it("publications datées : surprise à partir du résultat et du dividende, connue à la date de publication", async () => {
    const { fundamentals, panel } = await setup();
    fundamentals.upsert({ symbol: "SNTS", period: "2024", netIncome: 280e9, dps: 1500, publishedAt: "2025-03-10" }, 1);
    fundamentals.upsert({ symbol: "SNTS", period: "2025", netIncome: 322e9, dps: 1800, publishedAt: "2026-03-12" }, 1);
    const pubs = fundamentals.publications("SNTS");
    expect(pubs).toHaveLength(1); // 2024 n'a pas de comparatif
    expect(pubs[0].ts).toBe(utc(2026, 3, 12));
    expect(pubs[0].surprise).toBeCloseTo(0.6 * (15 / 40) + 0.4 * (20 / 40), 4);
    expect(panel.extrasAt("SNTS", utc(2026, 3, 11), 4000).pubDrift).toBe(0);
    expect(panel.extrasAt("SNTS", utc(2026, 3, 12), 4000).pubDrift).toBeCloseTo(pubs[0].surprise, 6);
    expect(panel.extrasAt("SNTS", utc(2026, 4, 11), 4000).pubDrift).toBeCloseTo(pubs[0].surprise * 0.5, 6);
  });

  it("fenêtre de dividende et carnet officiel lus à la date, cache vidé au changement", async () => {
    const { corporate, boc, panel, db } = await setup();
    corporate.upsertDividend({ symbol: "SGBC", fiscalYear: 2025, net: 500, exDate: "2026-06-10" }, 1);
    expect(panel.extrasAt("SGBC", utc(2026, 5, 26), 10000).divWindow).toBeCloseTo(0.5, 6);
    expect(panel.extrasAt("SGBC", utc(2026, 6, 12), 10000).divWindow).toBeCloseTo(-0.8, 6);
    expect(panel.extrasAt("SGBC", utc(2026, 3, 1), 10000).book5).toBe(0);
    const ts = utc(2026, 9, 1);
    db.prepare("INSERT INTO daily_stats(symbol, ts, bid, bid_qty, ask, ask_qty, reserved, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)").run("SGBC", ts, 10000, 300, 10100, 100, "up", "test", Date.now());
    expect(panel.extrasAt("SGBC", ts, 10000).book5).toBe(0); // cache antérieur
    boc.emit("boc", { session: ts, rows: 1 });
    const v = panel.extrasAt("SGBC", ts, 10000).book5!;
    expect(v).toBeCloseTo((3_000_000 - 1_010_000) / (3_000_000 + 1_010_000) + 0.2, 2);
    expect(panel.extrasAt("SGBC", ts - DAY, 10000).book5).toBe(0); // pas encore connu la veille
  });
});
