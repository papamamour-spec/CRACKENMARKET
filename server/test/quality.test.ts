import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { assessQuality, linear, type QualityInput } from "../src/engine/quality.js";
import { QualityService } from "../src/services/quality.js";
import { RadarService, classifyRadar } from "../src/services/radar.js";
import { DocumentService } from "../src/services/documents.js";
import { NewsService } from "../src/services/news.js";
import { AdvisorService } from "../src/services/advisor.js";
import { PortfolioService } from "../src/services/portfolio.js";
import { AuthService } from "../src/services/auth.js";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { INSTRUMENTS } from "../src/data/instruments.js";
import type { MarketService } from "../src/services/market.js";

const base: QualityInput = {
  symbol: "SNTS", name: "Sonatel", sector: "Télécommunications", price: 22000,
  avgValueTraded60: 250_000_000, zeroVolumeDays20: 0, volatility60: 0.18, maxDrawdown250: -0.12,
  dividendYield: 7.2, sectorMedianYield: 5.8,
  profile: { freeFloatPct: 35, mainHolderPct: 42, mainHolderName: "Orange", statePct: 27, sharesOutstanding: 100_000_000, payoutRatioPct: 80, dividendYears: 10, suspended: false, suspendedReason: null },
  publications: { lastAnnualReportYear: 2025, lastResultsDate: Date.UTC(2026, 7, 20), lastResultsPeriod: "S1 2026", documents: 8 },
  news: { score: 0.2, count: 4, suspensionMentioned: false },
  today: Date.UTC(2026, 10, 12),
};

describe("score de qualité", () => {
  it("note linéairement entre les seuils", () => {
    expect(linear(5, 5, 60)).toBe(1);
    expect(linear(60, 5, 60)).toBe(0);
    expect(linear(32.5, 5, 60)).toBeCloseTo(0.5, 5);
    expect(linear(40, 30, 10)).toBe(1); // ordre inversé (plus grand = mieux)
    expect(linear(20, 30, 10)).toBeCloseTo(0.5, 5);
  });
  it("un grand titre liquide et transparent est SOLIDE avec confiance totale", () => {
    const r = assessQuality(base);
    expect(r.band).toBe("SOLIDE");
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.confidence).toBe(1);
    expect(r.flags).toHaveLength(0);
    expect(r.parts).toHaveLength(5);
    expect(r.parts.every((p) => p.verified)).toBe(true);
    expect(r.headline).toMatch(/SOLIDE/);
  });
  it("une donnée absente est « non vérifiée », jamais comptée comme bonne", () => {
    const r = assessQuality({ ...base, profile: { ...base.profile, freeFloatPct: null, mainHolderPct: null }, publications: { lastAnnualReportYear: null, lastResultsDate: null, lastResultsPeriod: null, documents: 0 } });
    expect(r.unverified).toEqual(["transparence", "actionnariat"]);
    expect(r.confidence).toBe(0.6);
    expect(r.parts.filter((p) => !p.verified)).toHaveLength(2);
    // le score reste calculé sur le barème vérifié, sans pénaliser ni gratifier l'inconnu
    expect(r.score).toBeGreaterThanOrEqual(80);
    const r2 = assessQuality({ ...r && base, profile: { ...base.profile, freeFloatPct: null, mainHolderPct: null, dividendYears: null }, publications: { lastAnnualReportYear: null, lastResultsDate: null, lastResultsPeriod: null, documents: 0 } });
    expect(r2.confidence).toBe(0.6);
  });
  it("les drapeaux rouges forcent RISQUÉ et les plafonds limitent à FRAGILE", () => {
    const susp = assessQuality({ ...base, profile: { ...base.profile, suspended: true, suspendedReason: "défaut de publication" } });
    expect(susp.band).toBe("RISQUÉ");
    expect(susp.flags.some((f) => f.hard && /suspendue/.test(f.text))).toBe(true);
    const ff = assessQuality({ ...base, profile: { ...base.profile, freeFloatPct: 8 } });
    expect(ff.band).toBe("RISQUÉ");
    const late = assessQuality({ ...base, publications: { ...base.publications, lastAnnualReportYear: 2024 } }); // novembre 2026 sans rapport 2025
    expect(late.band).toBe("RISQUÉ");
    const illiq = assessQuality({ ...base, avgValueTraded60: 800_000 }); // 10 M / (0,8 M × 20 %) = 62 séances
    expect(illiq.band).toBe("FRAGILE");
    expect(illiq.score).toBeLessThanOrEqual(59);
    expect(illiq.flags.some((f) => !f.hard && /Liquidité faible/.test(f.text))).toBe(true);
    const payout = assessQuality({ ...base, profile: { ...base.profile, payoutRatioPct: 130 } });
    expect(payout.score).toBeLessThanOrEqual(59);
    const bad = assessQuality({ ...base, news: { score: -0.7, count: 5, suspensionMentioned: false } });
    expect(bad.score).toBeLessThanOrEqual(59);
    const noTrade = assessQuality({ ...base, zeroVolumeDays20: 20, avgValueTraded60: 0 });
    expect(noTrade.band).toBe("RISQUÉ");
    const weak = assessQuality({ ...base, volatility60: 0.7, maxDrawdown250: -0.6, dividendYield: 0, profile: { ...base.profile, mainHolderPct: 90, dividendYears: 0 } });
    expect(weak.band).toBe("FRAGILE"); // plafonné par l'actionnaire principal à 90 %
    expect(weak.score).toBeLessThanOrEqual(59);
  });
});

// marché factice sur historique synthétique
const histories = new Map(INSTRUMENTS.map((i) => [i.symbol, generateDailyHistory(i, 320)]));
function fakeMarket(): MarketService {
  const m = new EventEmitter() as unknown as MarketService & EventEmitter;
  Object.assign(m, {
    price: (s: string) => histories.get(s)!.at(-1)!.close,
    snapshot: (s: string) => ({ symbol: s, price: histories.get(s)!.at(-1)!.close, changePct: 0 }),
    history: (s: string, n: number) => histories.get(s)!.slice(-n),
    indexHistory: () => [],
  });
  return m;
}

describe("service qualité et profils", () => {
  it("évalue toutes les valeurs, enregistre un profil analyste et recalcule", () => {
    const db = openMemoryDb();
    const market = fakeMarket();
    const advisor = new AdvisorService(db, market, new PortfolioService(db, market));
    const docs = new DocumentService(db, []);
    const news = new NewsService(db, []);
    const svc = new QualityService(db, market, advisor);
    svc.attach(docs, news);
    const userId = new AuthService(db).register("a@ex.com", "secret123", "Analyste").id;
    const all = svc.all();
    expect(all).toHaveLength(INSTRUMENTS.length);
    const before = svc.assess("SNTS");
    expect(before.unverified).toContain("actionnariat");
    expect(before.unverified).toContain("transparence");
    expect(before.confidence).toBe(0.6);
    docs.importText("SNTS ; Rapport annuel 2025 ; https://ex.com/ra2025.pdf ; 2026-04-28\nSNTS ; Résultats du 1er semestre 2026 ; https://ex.com/s1-2026.pdf ; 2026-08-20");
    svc.saveProfile("SNTS", { freeFloatPct: 35, mainHolderPct: 42, mainHolderName: "Orange", dividendYears: 10 }, userId);
    const after = svc.assess("SNTS");
    expect(after.unverified).toEqual([]);
    expect(after.confidence).toBe(1);
    expect(svc.profile("SNTS").mainHolderName).toBe("Orange");
    // mise à jour partielle : les champs absents sont conservés
    svc.saveProfile("SNTS", { suspended: true, suspendedReason: "test" }, userId);
    expect(svc.profile("SNTS").freeFloatPct).toBe(35);
    expect(svc.assess("SNTS").band).toBe("RISQUÉ");
    expect(() => svc.saveProfile("XXXX", {}, userId)).toThrow();
    expect(svc.rules().parts.liquidite.max).toBe(25);
  });
});

describe("radar des événements", () => {
  it("classe les titres d'événements", () => {
    expect(classifyRadar("Suspension de la cotation de SETAO")).toBe("suspension");
    expect(classifyRadar("Introduction en bourse de la société X à la BRVM")).toBe("introduction");
    expect(classifyRadar("Lancement de l'emprunt obligataire TPCI 6% 2026-2033")).toBe("emission_obligataire");
    expect(classifyRadar("Offre publique d'achat sur les titres Y")).toBe("offre_publique");
    expect(classifyRadar("Sonatel : mise en paiement du dividende 2025")).toBe("dividende");
    expect(classifyRadar("Convocation à l'assemblée générale ordinaire")).toBe("assemblee");
    expect(classifyRadar("Résultats annuels 2025 : résultat net en hausse")).toBe("resultats");
    expect(classifyRadar("Recette de mafé")).toBeNull();
  });
  it("détecte les événements dans l'actualité, les documents et la cote, sans doublon", () => {
    const db = openMemoryDb();
    const news = new NewsService(db, []);
    const docs = new DocumentService(db, []);
    const radar = new RadarService(db, news, docs, null);
    news.ingest("test", [
      { title: "Introduction en bourse de Sonatel Mobile Money annoncée à la BRVM", url: "https://ex.com/1", summary: null, publishedAt: Date.now() - 3600_000 },
      { title: "La BRVM suspend la cotation de SETAO", url: "https://ex.com/2", summary: null, publishedAt: Date.now() - 7200_000 },
      { title: "Recette de mafé", url: "https://ex.com/3", summary: null, publishedAt: Date.now() },
    ]);
    docs.importText("SGBC ; Avis de mise en paiement du dividende 2025 ; https://ex.com/div.pdf ; 2026-06-01");
    const n = radar.scan();
    expect(n).toBeGreaterThanOrEqual(3);
    expect(radar.scan()).toBe(0); // idempotent
    const kinds = radar.list().map((e) => e.kind);
    expect(kinds).toContain("introduction");
    expect(kinds).toContain("suspension");
    expect(kinds).toContain("dividende");
    expect(radar.list({ kind: "suspension" })[0].symbol).toBe("STAC");
    expect(radar.list({ symbol: "SGBC" })[0].title).toMatch(/dividende/);
    expect(radar.status().recent48h).toBeGreaterThanOrEqual(3);
  });
});
