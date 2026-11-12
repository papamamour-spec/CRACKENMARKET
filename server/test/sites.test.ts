import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSikaCommuniques, parseSikaCompanyPage, parseSikaDividends, parseSikaHistory, parseSikaNews, parseSikaQuoteList, parseSymbolHref } from "../src/data/sika.js";
import { documentFromFilename, parseBrvmBonds, parseBrvmDocuments, parseBrvmNews, parseBrvmQuotes, parseBulletinLinks, parseCompanyIndex } from "../src/data/brvmSite.js";
import { isDisallowed, politeFetch, resetFetchPolicy } from "../src/services/fetchPolicy.js";

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const fx = (f: string) => fs.readFileSync(path.join(__dirname, "fixtures", "sites", f), "utf8");

describe("pages réelles de Sika Finance", () => {
  it("cotations de A à Z : symbole lu dans le lien, indices ignorés", () => {
    const q = parseSikaQuoteList(fx("sika_aaz.html"));
    expect(q.length).toBeGreaterThanOrEqual(5);
    expect(q.every((x) => /^[A-Z]{3,5}$/.test(x.symbol))).toBe(true);
    const boab = q.find((x) => x.symbol === "BOAB")!;
    expect(boab).toMatchObject({ suffix: "bj", name: "BANK OF AFRICA BENIN", open: 9475, volume: 552, value: 5230200, last: 9475, changePct: 0.69 });
    expect(parseSymbolHref("/marches/cotation_SNTS.sn")).toEqual({ symbol: "SNTS", suffix: "sn" });
    expect(parseSymbolHref("/marches/cotation_BRVMAG")).toBeNull();
  });

  it("historique : bougies chronologiques", () => {
    const h = parseSikaHistory(fx("sika_hist.html"));
    expect(h.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < h.length; i++) expect(h[i].ts).toBeGreaterThan(h[i - 1].ts);
    const last = h[h.length - 1];
    expect(last).toEqual({ ts: utc(2026, 11, 11), open: 4000, high: 4190, low: 4000, close: 4190, volume: 85624 });
  });

  it("dividendes : historique par exercice et détachements à venir", () => {
    const d = parseSikaDividends(fx("sika_dividendes.html"));
    const boab = d.history.find((x) => x.symbol === "BOAB")!;
    expect(boab.byYear).toEqual([{ year: 2022, amount: 273, yieldPct: 10.3 }, { year: 2023, amount: 353, yieldPct: 11.87 }, { year: 2024, amount: 468, yieldPct: 14.72 }, { year: 2025, amount: 585, yieldPct: 15.88 }]);
    expect(d.upcoming[0]).toMatchObject({ symbol: "LNBB", amount: 164, exDate: null, yieldPct: 4.32 });
  });

  it("fiche valeur : valorisation, bêta, dividendes", () => {
    const c = parseSikaCompanyPage(fx("sika_cotation.html"));
    expect(c.marketCapFcfa).toBe(4_190_000_000_000);
    expect(c.beta).toBe(1.42);
    expect(c.dividends[0]).toEqual({ year: 2025, amount: 174, yieldPct: 6.66 });
  });

  it("communiqués et actualités", () => {
    const k = parseSikaCommuniques(fx("sika_communiques.html"));
    expect(k[0]).toMatchObject({ date: utc(2026, 11, 10), company: "BANQUE INTERNATIONALE POUR LE COMMERCE DU BENIN" });
    expect(k[0].url).toMatch(/^https:\/\/www\.sikafinance\.com\/docs\/.*\.pdf$/);
    const n = parseSikaNews(fx("sika_actualites.html"));
    expect(n.length).toBe(3);
    expect(n[0].url).toMatch(/^https:\/\/www\.sikafinance\.com\/marches\/.+_\d+$/);
    expect(n[0].title.length).toBeGreaterThan(10);
    expect(n[0].publishedAt).not.toBeNull();
    expect(n[0].summary).not.toBeNull();
  });
});

describe("pages réelles de brvm.org", () => {
  it("bulletins officiels : une séance par lien, version corrigée privilégiée", () => {
    const l = parseBulletinLinks(fx("brvm_bulletins.html"));
    expect(l.length).toBeGreaterThanOrEqual(3);
    expect(l[0]).toEqual({ url: "https://www.brvm.org/sites/default/files/boc_20261111_2_0.pdf", sessionTs: utc(2026, 11, 11), title: "Bulletin Officiel de la Cote du 11 Novembre 2026" });
    expect(l[1].sessionTs).toBe(utc(2026, 11, 10));
    expect(new Set(l.map((x) => x.sessionTs)).size).toBe(l.length);
  });

  it("cote des actions et des obligations", () => {
    const q = parseBrvmQuotes(fx("brvm_actions.html"));
    expect(q[0]).toEqual({ symbol: "ABJC", name: "SERVAIR ABIDJAN COTE D'IVOIRE", volume: 315, prev: 3300, open: 3300, close: 3300, changePct: 0 });
    expect(q.find((x) => x.symbol === "BBGC")).toMatchObject({ close: 9450, changePct: -0.16 });
    const b = parseBrvmBonds(fx("brvm_obligations.html"));
    expect(b[0]).toMatchObject({ code: "BABS.O1", issueDate: utc(2025, 2, 25), maturityDate: null, priceFcfa: 9800, accrued: 31.52, lastCouponDate: utc(2026, 10, 24), lastCouponAmount: 318.72 });
  });

  it("index des sociétés, documents d'une société, annonces, actualités", () => {
    const idx = parseCompanyIndex(fx("brvm_index.html"));
    expect(idx.companies[0]).toEqual({ slug: "air-liquide-ci", url: "https://www.brvm.org/fr/rapports-societe-cotes/air-liquide-ci", name: "AIR LIQUIDE CI" });
    expect(idx.nextPages).toContain("https://www.brvm.org/fr/rapports-societes-cotees?page=1");
    const docs = parseBrvmDocuments(fx("brvm_societe.html"));
    expect(docs[0]).toMatchObject({ url: "https://www.brvm.org/sites/default/files/20260626_-_etats_financiers_-_exercice_2025_-_erium_ci.pdf", publishedAt: utc(2026, 6, 26) });
    expect(docs[0].title).toMatch(/Etats financiers/);
    expect(documentFromFilename("https://x/20251219_-_rapport_dactivites_-_1er_trimestre_2025_-_erium_ci.pdf")).toMatchObject({ publishedAt: utc(2025, 12, 19), title: "Rapport dactivites - 1er trimestre 2025 - erium ci" });
    const ag = parseBrvmDocuments(fx("brvm_annonces.html"));
    expect(ag[0]).toMatchObject({ publishedAt: utc(2026, 10, 2) });
    expect(ag[0].title.toLowerCase()).toMatch(/convocation|02\/10\/2026/);
    const news = parseBrvmNews(fx("brvm_actualites.html"));
    expect(news.length).toBeGreaterThanOrEqual(2);
    expect(news.some((n) => /BRIDGE BANK/.test(n.title) && n.publishedAt === utc(2026, 9, 24))).toBe(true);
  });
});

describe("politique de collecte", () => {
  it("interdit RichBourse et les documents de Sika, laisse passer le reste", () => {
    expect(isDisallowed("https://www.richbourse.com/common/societe/SNTS")).toMatch(/RichBourse/);
    expect(isDisallowed("https://www.sikafinance.com/docs/sonatel.pdf")).toMatch(/robots/);
    expect(isDisallowed("https://www.sikafinance.com/marches/aaz")).toBeNull();
    expect(isDisallowed("https://www.brvm.org/fr/cours-actions/0")).toBeNull();
  });

  it("espace les requêtes vers un même hôte", async () => {
    resetFetchPolicy();
    const calls: number[] = [];
    const fetchImpl = (async () => { calls.push(Date.now()); return new Response("ok"); }) as unknown as typeof fetch;
    const t0 = Date.now();
    await Promise.all([politeFetch("https://example.test/a", { fetchImpl }), politeFetch("https://example.test/b", { fetchImpl })]);
    expect(calls).toHaveLength(2);
    expect(calls[1] - t0).toBeGreaterThanOrEqual(900); // délai par défaut 1 s entre deux requêtes
    await expect(politeFetch("https://www.richbourse.com/x", { fetchImpl })).rejects.toThrow(/RichBourse/);
  });
});
