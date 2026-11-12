import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { parseAmount, parseFinancialNotice, parsePeriod, valuationMetrics, type FinancialRecord } from "../src/engine/fundamentals.js";
import { FundamentalsService, htmlToPlainText } from "../src/services/fundamentals.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { INSTRUMENTS } from "../src/data/instruments.js";

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

async function marketWithHistory(days = 80): Promise<{ market: MarketService; db: ReturnType<typeof openMemoryDb> }> {
  const db = openMemoryDb();
  ensureHistoryDepth(db, days);
  const market = new MarketService(db);
  const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void };
  await m.loadOrSeedHistory();
  for (const inst of INSTRUMENTS) m.initSnapshot(inst);
  return { market, db };
}

describe("lecture des publications financières", () => {
  it("montants et unités", () => {
    expect(parseAmount("1 234,5", "milliards")).toBe(1_234_500_000_000);
    expect(parseAmount("45", "Mds")).toBe(45e9);
    expect(parseAmount("12,3", "millions")).toBe(12_300_000);
    expect(parseAmount("1.250", undefined)).toBe(1250);
    expect(parseAmount("abc", "millions")).toBeNull();
  });

  it("période couverte", () => {
    expect(parsePeriod("Résultats annuels de l'exercice 2025")).toEqual({ period: "2025", periodEnd: utc(2025, 12, 31) });
    expect(parsePeriod("Comptes au 30 juin 2026 : premier semestre")).toEqual({ period: "S1 2026", periodEnd: utc(2026, 6, 30) });
    expect(parsePeriod("Activité du troisième trimestre 2025")).toEqual({ period: "T3 2025", periodEnd: utc(2025, 9, 30) });
    expect(parsePeriod("Sonatel : communiqué")).toEqual({ period: null, periodEnd: null });
  });

  it("communiqué de résultats : chiffre d'affaires, résultat, croissance, BPA, dividende", () => {
    const f = parseFinancialNotice("Sonatel publie ses résultats annuels 2025 : le chiffre d'affaires consolidé s'établit à 1 650,2 milliards de FCFA, en hausse de 8,4 %. Le résultat net part du groupe ressort à 312 milliards FCFA (+5,1 %). Les capitaux propres s'élèvent à 1 100 milliards de FCFA. Bénéfice par action de 3 120 FCFA ; dividende brut proposé de 1 750 FCFA par action. Abidjan, le 12 mars 2026.");
    expect(f.period).toBe("2025");
    expect(f.revenue).toBe(1_650_200_000_000);
    expect(f.revenueGrowthPct).toBe(8.4);
    expect(f.netIncome).toBe(312e9);
    expect(f.netIncomeGrowthPct).toBe(5.1);
    expect(f.equity).toBe(1_100e9);
    expect(f.eps).toBe(3120);
    expect(f.dps).toBe(1750);
    const bank = parseFinancialNotice("SGBC : au 30 juin 2026, le produit net bancaire atteint 98,5 milliards FCFA et le bénéfice net 41 milliards, en baisse de 3 %.");
    expect(bank.period).toBe("S1 2026");
    expect(bank.revenue).toBe(98.5e9);
    expect(bank.netIncome).toBe(41e9);
    expect(bank.netIncomeGrowthPct).toBe(-3);
    expect(parseFinancialNotice("Assemblée générale ordinaire le 25 avril 2026").revenue).toBeNull();
  });

  it("ratios de valorisation à partir des enregistrements", () => {
    const base = { symbol: "SNTS", publishedAt: null, shares: 100_000_000, dps: null, revenueGrowthPct: null, netIncomeGrowthPct: null, source: "test", url: null, note: null, status: "analyste" as const, updatedAt: 0, equity: null, eps: null };
    const records: FinancialRecord[] = [
      { ...base, id: 1, period: "2025", periodEnd: utc(2025, 12, 31), revenue: 1_000e9, netIncome: 100e9, equity: 500e9, dps: 600 },
      { ...base, id: 2, period: "2024", periodEnd: utc(2024, 12, 31), revenue: 900e9, netIncome: 80e9 },
      { ...base, id: 3, period: "S1 2026", periodEnd: utc(2026, 6, 30), revenue: 560e9, netIncome: 60e9 },
    ];
    const m = valuationMetrics(records, 15_000, null);
    expect(m.annualPeriod).toBe("2025");
    expect(m.latestPeriod).toBe("S1 2026");
    expect(m.eps).toBe(1000);
    expect(m.per).toBe(15);
    expect(m.earningsYieldPct).toBeCloseTo(6.7, 1);
    expect(m.bookValuePerShare).toBe(5000);
    expect(m.priceToBook).toBe(3);
    expect(m.roePct).toBe(20);
    expect(m.revenueGrowthPct).toBeCloseTo(11.1, 1);
    expect(m.netIncomeGrowthPct).toBe(25);
    expect(m.payoutPct).toBe(60);
    expect(m.netMarginPct).toBe(10);
    expect(m.missing).toEqual([]);
    const noShares = valuationMetrics([{ ...records[0], shares: null, eps: null }], 15_000, null);
    expect(noShares.per).toBeNull();
    expect(noShares.missing[0]).toMatch(/nombre d'actions/);
  });
});

describe("service des fondamentaux", () => {
  it("saisie, lecture automatique sans écrasement, import, rendement bénéficiaire daté", async () => {
    const { market, db } = await marketWithHistory();
    const svc = new FundamentalsService(db, market);
    const a = svc.upsert({ symbol: "SNTS", period: "2025", revenue: 1_000e9, netIncome: 100e9, shares: 100_000_000, publishedAt: "2026-03-12" }, 1);
    expect(a.status).toBe("analyste");
    expect(a.periodEnd).toBe(utc(2025, 12, 31));
    const auto = svc.ingestText("SNTS", "Sonatel, résultats de l'exercice 2025 : chiffre d'affaires de 1 200 milliards de FCFA, résultat net de 150 milliards FCFA, capitaux propres de 700 milliards FCFA.", "https://x/doc", "richbourse", null);
    expect(auto?.revenue).toBe(1_000e9); // saisie analyste conservée
    expect(auto?.equity).toBe(700e9); // champ vide complété
    expect(auto?.status).toBe("analyste");
    const r = svc.importText(["symbole;période;ca;rn;cp;actions;bpa;dpa;publication;source", "SNTS;2024;900 000 000 000;80 000 000 000;;100000000;;;2025-03-10;brvm", "SNTS;T4 2024;1;;;;;;;", "ZZZ;2025;1;;;;;;;"].join("\n"), 2);
    expect(r.imported).toHaveLength(1);
    expect(r.rejected).toHaveLength(2);
    const c = svc.company("SNTS");
    expect(c.records).toHaveLength(2);
    expect(c.metrics.annualPeriod).toBe("2025");
    expect(c.metrics.netIncomeGrowthPct).toBe(25);
    // rendement bénéficiaire connu à une date : 2025 publié le 12/03/2026, 2024 le 10/03/2025
    expect(svc.earningsYieldAt("SNTS", utc(2026, 1, 15), 10_000)).toBeCloseTo(8, 6); // 800 FCFA de BPA 2024 / 10 000
    expect(svc.earningsYieldAt("SNTS", utc(2026, 6, 15), 10_000)).toBeCloseTo(10, 6); // 1 000 FCFA de BPA 2025
    expect(svc.earningsYieldAt("SNTS", utc(2024, 6, 15), 10_000)).toBeNull();
    expect(svc.all().map((x) => x.symbol)).toEqual(["SNTS"]);
    expect(svc.status()).toMatchObject({ records: 2, companies: 1, auto: 0 });
    svc.remove(c.records[0].id);
    expect(svc.records("SNTS")).toHaveLength(1);
    expect(htmlToPlainText("<html><body><h1>Titre</h1><script>x()</script><p>Chiffre  d'affaires</p></body></html>")).toBe("Titre Chiffre d'affaires");
  });
});

describe("lecture automatique du corps des publications", () => {
  it("télécharge les documents une seule fois, dans la politique de collecte, et en extrait les chiffres", async () => {
    const { resetFetchPolicy } = await import("../src/services/fetchPolicy.js");
    const { DocumentService } = await import("../src/services/documents.js");
    resetFetchPolicy(0);
    const { market, db } = await marketWithHistory(60);
    const docs = new DocumentService(db, []);
    docs.importText("SNTS ; Résultats annuels 2025 ; https://docs.example/snts-resultats-2025.pdf ; 2026-03-15");
    let hits = 0;
    const fetchImpl = (async (url: string) => {
      hits++;
      if (!String(url).includes("snts-resultats-2025")) return new Response("", { status: 404 });
      return new Response("<html><body><h1>Sonatel : résultats de l'exercice 2025</h1><p>Chiffre d'affaires de 1 650 milliards de FCFA, en hausse de 8 %. Résultat net de 420 milliards de FCFA. Dividende proposé de 1 750 FCFA par action.</p></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const svc = new FundamentalsService(db, market, fetchImpl);
    svc.attach(docs, null, null);
    const r = await svc.scan(true);
    expect(r.fetched).toBe(1);
    expect(r.inserted).toBeGreaterThanOrEqual(1);
    const rec = svc.records("SNTS").find((x) => x.period === "2025")!;
    expect(rec.revenue).toBe(1_650_000_000_000);
    expect(rec.netIncome).toBe(420_000_000_000);
    // second passage : le document déjà lu n'est pas retéléchargé (mémoire persistée dans meta)
    const again = await svc.scan(true);
    expect(again.fetched).toBe(0);
    expect(hits).toBe(1);
    expect((db.prepare("SELECT value FROM meta WHERE key = 'fundamentals_fetched'").get() as { value: string }).value).toContain("snts-resultats-2025");
    // un document sous un chemin interdit (robots.txt de Sika) n'est jamais demandé
    docs.importText("ORAC ; États financiers 2025 ; https://www.sikafinance.com/docs/orac-2025.pdf ; 2026-04-01");
    const third = await svc.scan(true);
    expect(third.fetched).toBe(0);
    expect(hits).toBe(1);
  });
});
