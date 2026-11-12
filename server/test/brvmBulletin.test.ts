import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { looksLikeBrvmBulletin, parseBrvmBulletin, parseShortDate } from "../src/data/brvmBulletin.js";

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const text = fs.readFileSync(path.join(__dirname, "fixtures", "boc_brvm_sample.txt"), "utf8");

describe("bulletin officiel de la cote (format réel)", () => {
  const b = parseBrvmBulletin(text);

  it("en-tête : séance, numéro, indices", () => {
    expect(looksLikeBrvmBulletin(text)).toBe(true);
    expect(b.sessionTs).toBe(utc(2026, 11, 11));
    expect(b.issue).toBe("215");
    expect(b.indices.map((i) => [i.name, i.level, i.changePct])).toEqual([["BRVM COMPOSITE", 517.17, 0.85], ["BRVM 30", 250.13, 1.07], ["BRVM PRESTIGE", 192.47, 0.45]]);
    expect(parseShortDate("26-mai-26")).toBe(utc(2026, 5, 26));
    expect(parseShortDate("9-déc.-26")).toBe(utc(2026, 12, 9));
    expect(parseShortDate("29-sept.-17")).toBe(utc(2017, 9, 29));
  });

  it("actions : ligne complète, secteur, compartiment, dividende, PER", () => {
    const snts = b.equities.find((e) => e.symbol === "SNTS")!;
    expect(snts).toMatchObject({ name: "SONATEL SN", sector: "TEL", compartment: "PRESTIGE", prev: 4000, open: 4000, close: 4190, changePct: 4.75, volume: 85624, value: 346674225, ref: 4190, ytdPct: 60.41, lastDividendNet: 174, lastDividendDate: utc(2026, 5, 26), yieldPct: 4.15, per: 10.13, suspended: false, nonQuoted: false });
    const ntlc = b.equities.find((e) => e.symbol === "NTLC")!;
    expect(ntlc).toMatchObject({ sector: "CB", compartment: "PRESTIGE", close: 13130, lastDividendNet: 369.6, per: 15.73 });
  });

  it("actions : suspendu, non coté, sans dividende, montant collé à la date, PER absent", () => {
    expect(b.equities.find((e) => e.symbol === "SICC")).toMatchObject({ suspended: true, close: null, ref: 8400, ytdPct: 154.55, lastDividendNet: 1919, lastDividendDate: utc(2000, 9, 25), per: null });
    expect(b.equities.find((e) => e.symbol === "UNLC")).toMatchObject({ nonQuoted: true, close: null, ref: 47000, lastDividendNet: 1233, lastDividendDate: utc(2012, 7, 9), per: 674.05 });
    expect(b.equities.find((e) => e.symbol === "BBGC")).toMatchObject({ close: 9465, volume: 5793, value: 54727820, ref: 9465, ytdPct: null, lastDividendNet: null, per: 17.4, sector: "FIN", compartment: "PRINCIPAL" });
    expect(b.equities.find((e) => e.symbol === "ETIT")).toMatchObject({ close: 60, volume: 658363, lastDividendNet: 0.92, lastDividendDate: utc(2026, 6, 30), yieldPct: 1.53, per: 3.14 });
    expect(b.equities.find((e) => e.symbol === "BOAN")).toMatchObject({ lastDividendNet: 209.25, yieldPct: 4.25, per: 250.05 });
    expect(b.equities.find((e) => e.symbol === "SIVC")).toMatchObject({ close: 1750, lastDividendNet: 63, lastDividendDate: utc(2017, 9, 29), per: 85.25, yieldPct: null });
    expect(b.equities.find((e) => e.symbol === "STAC")).toMatchObject({ close: 2040, lastDividendNet: 66.15, yieldPct: 3.24, per: null });
    expect(b.equities.find((e) => e.symbol === "SEMC")).toMatchObject({ suspended: true, ref: 1495, lastDividendNet: 14, yieldPct: 0.94, per: 37.21 });
    expect(b.equities.every((e) => e.sector)).toBe(true);
  });

  it("obligations : non cotée, négociée, suspendue, catégories", () => {
    const eom = b.bonds.find((x) => x.code === "EOM.O10")!;
    expect(eom).toMatchObject({ category: "classiques", nominal: 10000, prev: 10000, close: null, ref: 10000, volume: null, accrued: 572.44, period: "A", couponNet: 620, nextCouponDate: utc(2026, 12, 9), amortization: "ACD", suspended: false });
    expect(b.bonds.find((x) => x.code === "TPBF.O21")).toMatchObject({ close: 10000, volume: 33, value: 330000, accrued: 294.97, period: "S", couponNet: 325 });
    expect(b.bonds.find((x) => x.code === "TPCI.O77")).toMatchObject({ close: null, suspended: true, ref: 10000, accrued: 144.25, period: "T" });
    expect(b.bonds.find((x) => x.code === "SNTS.O2")).toMatchObject({ nominal: 2000, ref: 2000, amortization: "ACD" });
    expect(b.bonds.find((x) => x.code === "FSNTS.O1")).toMatchObject({ category: "fctc", ref: 10750 });
    expect(b.bonds.find((x) => x.code === "EOS.O24")).toMatchObject({ prev: 8386, ref: 8386, close: null });
  });

  it("carnet des actions : deux côtés, barre sur la ligne suivante, un seul côté, aucun ordre", () => {
    expect(b.equityBook.find((x) => x.symbol === "ETIT")).toMatchObject({ bidQty: 9303, bid: 59, ask: 60, askQty: 298700, ref: 60 });
    expect(b.equityBook.find((x) => x.symbol === "BOAB")).toMatchObject({ bidQty: 3, bid: 9410, ask: 9475, askQty: 159, ref: 9410 });
    expect(b.equityBook.find((x) => x.symbol === "SEMC")).toMatchObject({ bidQty: null, bid: null, ask: null, askQty: null, ref: 1495 });
    expect(b.equityBook.find((x) => x.symbol === "SICC")).toMatchObject({ bid: null, ask: null, ref: 8400 });
    expect(b.equityBook.find((x) => x.symbol === "UNLC")).toMatchObject({ bidQty: 3, bid: 47000, ask: 47500, askQty: 3, ref: 47000 });
  });

  it("carnet des obligations : un seul côté, décimales", () => {
    expect(b.bondBook.find((x) => x.symbol === "FBOAD.O1")).toMatchObject({ bid: null, ask: 3700, askQty: 100, ref: 3700 });
    expect(b.bondBook.find((x) => x.symbol === "FCAGS.O2")).toMatchObject({ bidQty: 12, bid: 8571, ask: 9213.83, askQty: 100, ref: 9214 });
    expect(b.bondBook.find((x) => x.symbol === "FNSBB.O2")).toMatchObject({ bidQty: 20, bid: 7600, ask: null, ref: 7600 });
    expect(b.bondBook.find((x) => x.symbol === "FBOAD.O2")).toMatchObject({ bid: null, ask: null, ref: 6356 });
  });

  it("opérations, avis et communiqués", () => {
    expect(b.notices.find((n) => n.section === "operations")).toMatchObject({ issuer: "SWAMI AGRI SAU" });
    const avis = b.notices.find((n) => n.section === "avis")!;
    expect(avis.issuer).toBe("AMF-UMOA");
    expect(avis.subject).toMatch(/INVICTUS/);
    const com = b.notices.find((n) => n.section === "communiques")!;
    expect(com.nature).toMatch(/Rapport d'activités/);
    expect(com.subject).toMatch(/AFINHAB/);
  });
});
