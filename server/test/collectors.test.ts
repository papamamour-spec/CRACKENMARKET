import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { INSTRUMENTS } from "../src/data/instruments.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { BocService } from "../src/services/boc.js";
import { BondService } from "../src/services/bonds.js";
import { CorporateService } from "../src/services/corporate.js";
import { NewsService } from "../src/services/news.js";
import { HistoryService } from "../src/services/history.js";
import { QualityService } from "../src/services/quality.js";
import { AdvisorService } from "../src/services/advisor.js";
import { PortfolioService } from "../src/services/portfolio.js";
import { resetFetchPolicy } from "../src/services/fetchPolicy.js";

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const fx = (f: string) => fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8");

async function marketWithHistory(days = 120): Promise<{ market: MarketService; db: ReturnType<typeof openMemoryDb> }> {
  const db = openMemoryDb();
  ensureHistoryDepth(db, days);
  const market = new MarketService(db);
  const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void };
  await m.loadOrSeedHistory();
  for (const inst of INSTRUMENTS) m.initSnapshot(inst);
  return { market, db };
}

/** fetch factice : sert les fixtures selon l'adresse. */
function stubFetch(routes: Record<string, string | Uint8Array>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    const body = routes[key];
    return new Response(body, { status: 200, headers: { "content-type": typeof body === "string" ? "text/html" : "application/pdf" } });
  }) as unknown as typeof fetch;
}

describe("historique réel et recalage du synthétique", () => {
  it("importe des séances réelles, supprime le synthétique postérieur et recale le synthétique antérieur", async () => {
    const { market, db } = await marketWithHistory(120);
    const raw = market.history("SNTS", 100000, false);
    const n = raw.length;
    expect(n).toBeGreaterThanOrEqual(120);
    const cut = raw[raw.length - 10].ts;
    // 10 séances réelles à un niveau très différent du synthétique (4 000 contre ~22 500 avant mise à jour du référentiel)
    const real = raw.slice(-10).map((c, i) => ({ ts: c.ts, open: 4000 + i * 10, high: 4050 + i * 10, low: 3990 + i * 10, close: 4020 + i * 10, volume: 1000 + i }));
    const r = market.importRealCandles("SNTS", real, "sika");
    expect(r.inserted).toBe(10);
    expect(r.removed).toBe(0);
    expect(r.rescaled).toBe(n - 10);
    const after = market.history("SNTS", 100000, false);
    expect(after.length).toBe(n);
    expect(after[after.length - 10]).toMatchObject({ ts: cut, open: 4000, close: 4020 });
    // raccord : la dernière clôture synthétique égale l'ouverture de la première séance réelle
    expect(after[after.length - 11].close).toBeCloseTo(4000, 6);
    expect(market.realHistorySince("SNTS")).toBe(cut);
    const st = market.historyStatus().find((s) => s.symbol === "SNTS")!;
    expect(st.realCandles).toBe(10);
    expect((db.prepare("SELECT source FROM candles WHERE symbol = 'SNTS' AND ts = ?").get(cut) as { source: string }).source).toBe("sika");
    // une seconde importation chevauchante n'ajoute rien de faux et ne recale plus
    const r2 = market.importRealCandles("SNTS", real.slice(5), "sika");
    expect(r2.rescaled).toBe(0);
    expect(market.history("SNTS", 100000, false).length).toBe(n);
  });

  it("collecte Sika : suffixes depuis la liste, historique par valeur, capitalisation vers le profil", async () => {
    resetFetchPolicy(0);
    const { market, db } = await marketWithHistory(80);
    const fetchImpl = stubFetch({ "/marches/aaz": fx("sites/sika_aaz.html"), "/marches/historiques/SNTS.sn": fx("sites/sika_hist.html"), "/marches/cotation_SNTS.sn": fx("sites/sika_cotation.html") });
    process.env.SIKA_BASE = "https://sika.test";
    const h = new HistoryService(db, market, fetchImpl);
    delete process.env.SIKA_BASE;
    const quality = new QualityService(db, market, new AdvisorService(db, market, new PortfolioService(db, market)));
    h.attachQuality(quality);
    expect(await h.loadSuffixes()).toBeGreaterThanOrEqual(5);
    const r = await h.refresh(["SNTS", "BOAB"]);
    expect(r.ok).toBe(1);
    expect(r.failed.some((f) => f.startsWith("BOAB"))).toBe(true);
    expect(r.inserted).toBeGreaterThanOrEqual(5);
    expect(market.realHistorySince("SNTS")).not.toBeNull();
    expect(market.history("SNTS", 5, false).find((c) => c.ts === utc(2026, 11, 11))).toMatchObject({ close: 4190 });
    // la capitalisation hebdomadaire est déjà passée pendant refresh() ; un second passage ne change rien (écart < 2 %)
    const caps = await h.refreshMarketCaps(["SNTS"]);
    expect(caps.failed).toEqual([]);
    expect(h.status().lastCapRun?.updated).toBe(0);
    expect(quality.profile("SNTS").sharesOutstanding).toBe(Math.round(4_190_000_000_000 / market.price("SNTS")));
    expect(h.status().realCoverage).toBeGreaterThan(0);
  });
});

describe("bulletin officiel : collecte automatique et application", () => {
  it("lit un bulletin réel : cours, carnet, obligations, dividendes, avis", async () => {
    resetFetchPolicy(0);
    const { market, db } = await marketWithHistory(80);
    const bonds = new BondService(db);
    const corporate = new CorporateService(db, market);
    const news = new NewsService(db);
    const boc = new BocService(db, market, stubFetch({}));
    boc.attach(bonds, corporate, news);
    const r = boc.importText(fx("boc_brvm_sample.txt"), null, "brvm:https://www.brvm.org/sites/default/files/boc_20261111_2.pdf");
    expect(r.session).toBe(utc(2026, 11, 11));
    expect(r.layout).toBe("bulletin BRVM");
    expect(r.applied).toBeGreaterThanOrEqual(8);
    const snts = boc.latest("SNTS")!;
    expect(snts).toMatchObject({ close: 4190, volume: 85624, bid: 4185, ask: 4190, per: 10.13, yieldPct: 4.15, lastDividend: 174, lastDividendDate: utc(2026, 5, 26), ytdPct: 60.41 });
    expect(boc.latest("ETIT")).toMatchObject({ bid: 59, bidQty: 9303, ask: 60, askQty: 298700 });
    expect(boc.latest("SICC")).toMatchObject({ suspended: true, close: null });
    expect(market.history("SNTS", 5, false).find((c) => c.ts === utc(2026, 11, 11))).toMatchObject({ close: 4190 });
    // dividendes : exercice = année de paiement − 1
    const d = corporate.dividends("SNTS").find((x) => x.fiscalYear === 2025)!;
    expect(d).toMatchObject({ net: 174, paymentDate: utc(2026, 5, 26), status: "payé" });
    expect(r.dividends).toBeGreaterThanOrEqual(5);
    // obligations : cours en % du nominal
    const tp = bonds.list().find((b) => b.code === "TPBF.O21")!;
    expect(tp.quote.pricePct).toBe(100);
    const eos = bonds.list().find((b) => b.code === "EOS.O24")!;
    expect(eos.quote.pricePct).toBeCloseTo(83.86, 2);
    expect(r.bonds).toBeGreaterThanOrEqual(4);
    // avis et communiqués dans la veille
    expect(r.notices).toBeGreaterThanOrEqual(2);
    expect(news.latest(10).some((n) => /INVICTUS/.test(n.title))).toBe(true);
    expect(boc.perAt("SNTS", utc(2026, 11, 12))).toBe(10.13);
    expect(boc.perAt("SNTS", utc(2026, 11, 10))).toBeNull();
  });

  it("découvre les bulletins manquants sur la page de brvm.org et les applique dans l'ordre", async () => {
    resetFetchPolicy(0);
    const { market, db } = await marketWithHistory(80);
    const bulletin = fx("boc_brvm_sample.txt");
    const fetchImpl = stubFetch({ "bulletins-officiels-de-la-cote": fx("sites/brvm_bulletins.html"), "boc_20261111_2_0.pdf": bulletin, "boc_20261110_2.pdf": bulletin.replace("mercredi 11 novembre 2026 ; N° 215", "mardi 10 novembre 2026 ; N° 214") });
    // le bulletin le plus ancien de la page (9 novembre) est absent : échec consigné, les autres sont appliqués
    const boc = new BocService(db, market, fetchImpl);
    const run = await boc.refresh(false, 3);
    expect(run?.ok).toBe(true);
    expect(run?.session).toBe(utc(2026, 11, 11));
    expect(run?.error).toMatch(/boc_20261109_2\.pdf/);
    expect(boc.status().sessions).toBe(2);
    expect(boc.hasSession(utc(2026, 11, 10))).toBe(true);
    // rien de nouveau au second passage
    const again = await boc.refresh(false, 3);
    expect(again?.applied).toBe(0);
  }, 30000);
});

describe("dividendes Sika", () => {
  it("historique par exercice et détachements à venir, sans écraser une saisie", async () => {
    resetFetchPolicy(0);
    const { market, db } = await marketWithHistory(60);
    const corporate = new CorporateService(db, market);
    corporate.upsertDividend({ symbol: "BOAB", fiscalYear: 2025, net: 600, status: "approuvé" }, 1);
    const r = await corporate.refreshFromSika(stubFetch({ "/marches/dividendes": fx("sites/sika_dividendes.html") }), "https://sika.test");
    expect(r.history).toBeGreaterThanOrEqual(8);
    const boab = corporate.dividends("BOAB");
    expect(boab.find((d) => d.fiscalYear === 2024)?.net).toBe(468);
    expect(boab.find((d) => d.fiscalYear === 2025)?.net).toBe(600); // saisie analyste conservée
    expect(boab.find((d) => d.fiscalYear === 2022)?.source).toMatch(/Sika/);
  });
});
