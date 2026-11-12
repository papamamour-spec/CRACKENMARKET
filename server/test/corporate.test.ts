import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { adjustCandles, detectSplits, parseDividendNotice } from "../src/engine/corporate.js";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { INSTRUMENT_MAP, INSTRUMENTS } from "../src/data/instruments.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { CorporateService } from "../src/services/corporate.js";
import { forecast } from "../src/engine/forecast.js";
import type { Candle } from "../src/engine/indicators.js";

const DAY = 86_400_000;
const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

function series(n: number, start = utc(2026, 1, 5), close = 10000): Candle[] {
  const out: Candle[] = [];
  let ts = start;
  for (let i = 0; i < n; i++) {
    while ([0, 6].includes(new Date(ts).getUTCDay())) ts += DAY;
    out.push({ ts, open: close, high: close * 1.01, low: close * 0.99, close, volume: 100 });
    ts += DAY;
  }
  return out;
}

/** Service de marché réel sur base mémoire, sans flux : historique synthétique chargé, instantanés initialisés. */
async function marketWithHistory(days = 300): Promise<MarketService> {
  const db = openMemoryDb();
  ensureHistoryDepth(db, days);
  const market = new MarketService(db);
  const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void };
  await m.loadOrSeedHistory();
  for (const inst of INSTRUMENTS) m.initSnapshot(inst);
  return market;
}

describe("historique ajusté des opérations sur le capital", () => {
  it("fractionnement : cours divisés et volumes multipliés avant la date d'effet, rien après", () => {
    const c = series(10);
    const ex = c[5].ts;
    const r = adjustCandles(c, [{ symbol: "X", kind: "split", exDate: ex, ratio: 10 }]);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].priceFactor).toBe(0.1);
    expect(r.candles[0].close).toBeCloseTo(1000, 6);
    expect(r.candles[0].volume).toBe(1000);
    expect(r.candles[4].high).toBeCloseTo(1010, 6);
    expect(r.candles[5].close).toBe(10000);
    expect(r.candles[9].volume).toBe(100);
    // l'original n'est pas modifié
    expect(c[0].close).toBe(10000);
  });

  it("dividende : facteur 1 − D / C sur la clôture de la veille, cumulé avec un fractionnement antérieur", () => {
    const c = series(12);
    const r = adjustCandles(c, [
      { symbol: "X", kind: "split", exDate: c[4].ts, ratio: 2 },
      { symbol: "X", kind: "dividend", exDate: c[9].ts, amount: 500 },
    ]);
    expect(r.steps.map((s) => s.kind)).toEqual(["dividend", "split"]);
    expect(r.candles[8].close).toBeCloseTo(9500, 6); // ×0,95
    expect(r.candles[3].close).toBeCloseTo(4750, 6); // ×0,95 ×0,5
    expect(r.candles[9].close).toBe(10000);
    expect(r.totalFactor).toBeCloseTo(0.475, 4);
  });

  it("ignore un dividende sans montant, supérieur au cours ou hors de la série", () => {
    const c = series(6);
    const r = adjustCandles(c, [
      { symbol: "X", kind: "dividend", exDate: c[3].ts, amount: null },
      { symbol: "X", kind: "dividend", exDate: c[3].ts, amount: 20000 },
      { symbol: "X", kind: "split", exDate: c[0].ts - 30 * DAY, ratio: 5 },
      { symbol: "X", kind: "split", exDate: c[5].ts + 30 * DAY, ratio: 5 },
    ]);
    expect(r.steps).toHaveLength(0);
    expect(r.candles.map((x) => x.close)).toEqual(c.map((x) => x.close));
  });

  it("détecte un fractionnement probable et ignore les variations ordinaires", () => {
    const c = series(30);
    for (let i = 10; i < 30; i++) {
      const px = 1000 * (1 + 0.02 * Math.sin(i));
      c[i] = { ...c[i], open: px, high: px, low: px, close: px };
    }
    c[5] = { ...c[5], close: 10700 }; // +7 % : pas une opération
    const found = detectSplits("X", c);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "split", ratio: 10, exDate: c[10].ts });
    expect(detectSplits("X", series(30))).toHaveLength(0);
  });

  it("lit un avis de dividende : montants, exercice, dates, statut", () => {
    const n = parseDividendNotice("Sonatel : dividende brut de 1 500 FCFA par action au titre de l'exercice 2025 approuvé par l'assemblée générale du 28 avril 2026 ; détachement le 15 mai 2026, mise en paiement le 30/05/2026.");
    expect(n.gross).toBe(1500);
    expect(n.fiscalYear).toBe(2025);
    expect(n.exDate).toBe(utc(2026, 5, 15));
    expect(n.paymentDate).toBe(utc(2026, 5, 30));
    expect(n.agmDate).toBe(utc(2026, 4, 28));
    expect(n.status).toBe("payé");
    const p = parseDividendNotice("Le conseil d'administration propose un dividende net de 125,50 FCFA par action pour 2024");
    expect(p.net).toBe(125.5);
    expect(p.fiscalYear).toBe(2024);
    expect(p.status).toBe("proposé");
    expect(parseDividendNotice("Résultats semestriels en hausse").gross).toBeNull();
  });
});

describe("service des actions sur le capital et des dividendes", () => {
  it("un dividende daté ajuste l'historique servi aux modèles, pas l'historique affiché", async () => {
    const market = await marketWithHistory(300);
    const db = (market as unknown as { db: ReturnType<typeof openMemoryDb> }).db;
    const svc = new CorporateService(db, market);
    const raw = market.history("SNTS", 300, false);
    const ex = raw[raw.length - 20].ts;
    const closeBefore = raw[raw.length - 21].close;
    svc.upsertDividend({ symbol: "SNTS", fiscalYear: 2025, gross: 1000, net: 900, exDate: new Date(ex).toISOString().slice(0, 10), status: "payé" }, 1);
    const adj = market.history("SNTS", 300);
    expect(adj[adj.length - 21].close).toBeCloseTo(closeBefore * (1 - 900 / closeBefore), 6);
    expect(adj[adj.length - 20].close).toBe(raw[raw.length - 20].close);
    expect(adj[adj.length - 1].close).toBe(raw[raw.length - 1].close);
    expect(market.history("SNTS", 300, false)[0].close).toBe(raw[0].close);
    expect(market.adjustmentSteps("SNTS")).toHaveLength(1);
    // suppression : la série redevient brute
    svc.removeDividend(svc.dividends("SNTS")[0].id);
    expect(market.adjustmentSteps("SNTS")).toHaveLength(0);
    expect(market.history("SNTS", 300)[0].close).toBe(raw[0].close);
  });

  it("une source automatique complète sans écraser une saisie d'analyste ; le statut ne régresse pas", async () => {
    const market = await marketWithHistory(80);
    const db = (market as unknown as { db: ReturnType<typeof openMemoryDb> }).db;
    const svc = new CorporateService(db, market);
    svc.upsertDividend({ symbol: "SGBC", fiscalYear: 2025, gross: 2000, status: "approuvé" }, 7);
    const auto = svc.ingestText("SGBC", "SGBC : dividende brut de 1 800 FCFA au titre de l'exercice 2025, détachement le 10/06/2026, proposé au vote", "https://x/y", "sika");
    expect(auto?.gross).toBe(2000); // montant de l'analyste conservé
    expect(auto?.exDate).toBe(utc(2026, 6, 10)); // champ vide complété
    expect(auto?.status).toBe("approuvé"); // pas de régression vers « proposé »
    expect(auto?.source).toBe("analyste");
    expect(auto?.netEstimated).toBe(1800); // 2000 × (1 − 10 %)
    expect(svc.dividendInfo("SGBC", 20000).yieldPct).toBe(9);
  });

  it("import en bloc, calendrier réel, exercices multiples", async () => {
    const market = await marketWithHistory(80);
    const db = (market as unknown as { db: ReturnType<typeof openMemoryDb> }).db;
    const svc = new CorporateService(db, market);
    // exercice 2025 détaché (passé), exercice 2026 annoncé pour 2027 (futur)
    const r = svc.importDividends(["symbole;exercice;brut;net;détachement;paiement;assemblée;statut;source", "SNTS;2025;1 650;1485;2026-05-20;2026-06-05;;payé;brvm", "SNTS;2026;1700;;20/05/2027;05/06/2027;28/04/2027;approuvé;sgi", "ZZZZ;2025;10;;;;;;", "SNTS;abcd;1;;;;;;"].join("\n"), 3);
    expect(r.imported).toHaveLength(2);
    expect(r.rejected).toHaveLength(2);
    const cal = svc.calendar(2027);
    const div = cal.filter((e) => e.symbol === "SNTS" && e.kind === "dividend");
    expect(div.some((e) => e.date === utc(2027, 5, 20) && !e.indicative)).toBe(true);
    expect(div.some((e) => e.id === "SNTS-div-2027")).toBe(false); // l'événement indicatif est remplacé
    expect(cal.some((e) => e.id === "SNTS-agm-real-2026")).toBe(true);
    const info = svc.dividendInfo("SNTS", 22000);
    expect(info.years).toBe(2);
    expect(info.last?.fiscalYear).toBe(2025);
    expect(info.last?.netEstimated).toBe(1485);
    expect(info.next).toMatchObject({ fiscalYear: 2026, exDate: utc(2027, 5, 20), amount: 1530 });
    expect(svc.status()).toMatchObject({ dividends: 2, symbolsWithDividends: 1 });
  });

  it("détection puis confirmation d'un fractionnement : la série ajustée n'a plus de rupture", async () => {
    const market = await marketWithHistory(200);
    const db = (market as unknown as { db: ReturnType<typeof openMemoryDb> }).db;
    const svc = new CorporateService(db, market);
    const arr = (market as unknown as { candles: Map<string, Candle[]> }).candles.get("BOAB")!;
    for (let i = 150; i < arr.length; i++) { const c = arr[i]; arr[i] = { ...c, open: c.open / 10, high: c.high / 10, low: c.low / 10, close: c.close / 10, volume: c.volume * 10 }; }
    const d = svc.detect();
    expect(d.inserted).toBe(1);
    expect(d.suspected[0]).toMatchObject({ symbol: "BOAB", kind: "split", ratio: 10, status: "suspecté" });
    // suspecté : pas encore appliqué
    expect(market.adjustmentSteps("BOAB")).toHaveLength(0);
    svc.confirmAction(d.suspected[0].id, 2);
    const adj = market.history("BOAB", 200);
    const jump = Math.abs(adj[150].close / adj[149].close - 1);
    expect(jump).toBeLessThan(0.1);
    expect(svc.actions("BOAB", false)[0].status).toBe("confirmé");
    // une nouvelle détection ne duplique pas
    expect(svc.detect().inserted).toBe(0);
  });

  it("le moteur de prévision retranche un détachement attendu dans l'horizon des objectifs de cours", () => {
    const inst = INSTRUMENT_MAP.get("SNTS")!;
    const candles = generateDailyHistory(inst, 600, new Date(utc(2026, 11, 10)), 22000, 1);
    const last = candles[candles.length - 1];
    const base = forecast({ symbol: "SNTS", candles, seed: 3 });
    const withDiv = forecast({ symbol: "SNTS", candles, seed: 3, upcomingDividend: { exDate: last.ts + 10 * DAY, amount: 1100 } });
    const b1 = base.horizons.find((h) => h.horizon === "1M")!;
    const d1 = withDiv.horizons.find((h) => h.horizon === "1M")!;
    expect(d1.dividendInHorizon).toMatchObject({ amount: 1100, pct: 5 });
    expect(d1.expectedReturnPct).toBe(b1.expectedReturnPct); // rendement total inchangé
    expect(d1.priceTargets.p50).toBe(b1.priceTargets.p50 - 1100);
    expect(d1.explanations.some((e) => /Détachement de 1/.test(e))).toBe(true);
    // 1 semaine : détachement hors horizon
    expect(withDiv.horizons.find((h) => h.horizon === "1W")!.dividendInHorizon).toBeNull();
  });
});

describe("rendement durable", () => {
  it("prend la médiane des derniers exercices et signale un dividende exceptionnel", async () => {
    const { openMemoryDb } = await import("../src/db/index.js");
    const { CorporateService } = await import("../src/services/corporate.js");
    const { MarketService, ensureHistoryDepth } = await import("../src/services/market.js");
    const db = openMemoryDb();
    ensureHistoryDepth(db, 30);
    const svc = new CorporateService(db, new MarketService(db));
    svc.upsertDividend({ symbol: "FTSC", fiscalYear: 2023, net: 95, status: "payé" }, 1);
    svc.upsertDividend({ symbol: "FTSC", fiscalYear: 2024, net: 105, status: "payé" }, 1);
    svc.upsertDividend({ symbol: "FTSC", fiscalYear: 2025, net: 1727, status: "payé" }, 1);
    const info = svc.dividendInfo("FTSC", 1690);
    expect(info.yieldPct).toBeCloseTo(102.2, 1);
    expect(info.sustainableYieldPct).toBeCloseTo((105 / 1690) * 100, 1);
    expect(info.exceptional).toBe(true);
    expect(svc.yieldFor("FTSC", 1690)).toBe(info.sustainableYieldPct);
    // un seul dividende connu, rendement démesuré : plafonné
    svc.upsertDividend({ symbol: "SICC", fiscalYear: 2025, net: 5000, status: "payé" }, 1);
    const one = svc.dividendInfo("SICC", 8000);
    expect(one.yieldPct).toBeCloseTo(62.5, 1);
    expect(one.sustainableYieldPct).toBe(15);
    expect(one.exceptional).toBe(true);
    // dividende régulier : inchangé
    svc.upsertDividend({ symbol: "SGBC", fiscalYear: 2025, net: 1800, status: "payé" }, 1);
    expect(svc.dividendInfo("SGBC", 20000)).toMatchObject({ yieldPct: 9, sustainableYieldPct: 9, exceptional: false });
  });
});
