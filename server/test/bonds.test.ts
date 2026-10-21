import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { BOND_MAP, BONDS, BRVM_COTE_SNAPSHOT, defFromLabel, parseCoteText, type BondDef } from "../src/data/bonds.js";
import { accruedInterest, analyzeBond, cleanPrice, dirtyPrice, fullSchedule, remainingCashFlows, yieldFromCleanPrice } from "../src/engine/bonds.js";
import { BondService, parseCoteHtml } from "../src/services/bonds.js";

// Émission de référence pour les calculs : 6,15 %, semestriel, différé 3 ans, amortissement constant
const b: BondDef = { code: "TEST.O30", name: "Test 6,15 % 2023-2030", issuer: "Test", issuerType: "souverain", country: "CI", couponPct: 6.15, issueDate: "2023-06-15", maturityDate: "2030-06-15", nominal: 10000, frequency: 2, amortization: "constant", graceYears: 3, taxExempt: true };
const AT = Date.parse("2026-10-15");

describe("calculs obligataires", () => {
  it("construit un échéancier qui rembourse exactement le nominal", () => {
    const s = fullSchedule(b);
    expect(s.length).toBe(14); // 7 ans × 2
    expect(s.slice(0, 6).every((f) => f.principal === 0)).toBe(true); // différé 3 ans
    expect(s.reduce((a, f) => a + f.principal, 0)).toBeCloseTo(10000, 6);
    expect(s[s.length - 1].outstandingAfter).toBe(0);
    expect(s[0].coupon).toBeCloseTo((10000 * 0.0615) / 2, 6);
  });
  it("vaut le pair (hors couru) quand le rendement égale le coupon, à une date de coupon", () => {
    const atCoupon = Date.parse("2026-06-15");
    const p = cleanPrice(b, 0.0615, atCoupon);
    expect(Math.abs(p - 10000) / 10000).toBeLessThan(0.01); // composition annuelle vs semestrielle : < 1 %
  });
  it("inverse prix ↔ rendement et calcule le coupon couru", () => {
    const y = 0.07;
    const p = cleanPrice(b, y, AT);
    expect(yieldFromCleanPrice(b, p, AT)).toBeCloseTo(y, 5);
    expect(p).toBeLessThan(10000); // rendement > coupon → décote
    const acc = accruedInterest(b, AT);
    expect(acc).toBeGreaterThan(0);
    expect(acc).toBeLessThan((10000 * 0.0615) / 2);
    expect(dirtyPrice(b, y, AT)).toBeCloseTo(p + acc, 6);
  });
  it("mesure duration, sensibilité et prochains flux", () => {
    const a = analyzeBond(b, 9800, AT);
    expect(a.ytmPct).toBeGreaterThan(6.15);
    expect(a.macaulayYears).toBeGreaterThan(1);
    expect(a.macaulayYears).toBeLessThan(a.remainingYears);
    expect(a.modifiedDuration).toBeLessThan(a.macaulayYears);
    expect(a.dv01).toBeGreaterThan(0);
    expect(a.nextCoupon!.date).toBeGreaterThan(AT);
    expect(remainingCashFlows(b, AT).length).toBe(8); // déc. 2026 → juin 2030
    // in fine : un seul remboursement à l'échéance
    const boad = BOND_MAP.get("BIDC.O7")!;
    const s = fullSchedule(boad);
    expect(s.slice(0, -1).every((f) => f.principal === 0)).toBe(true);
    expect(s[s.length - 1].principal).toBe(10000);
  });
});

describe("cote officielle BRVM", () => {
  it("analyse le tableau collé de la cote (symbole, libellé, cours en % du nominal)", () => {
    const rows = parseCoteText(BRVM_COTE_SNAPSHOT);
    expect(rows).toHaveLength(45);
    const eos = rows.find((r) => r.code === "EOS.O17")!;
    expect(eos.closePct).toBe(92);
    expect(eos.volume).toBe(65);
    expect(rows.find((r) => r.code === "TPCI.O39")!.closePct).toBeNull(); // cours 0 = non coté
  });
  it("déduit les caractéristiques d'un libellé officiel", () => {
    const d = defFromLabel("EOS.O20", "Etat du Sénégal 6,75% 2025-2032(1)");
    expect(d.issuer).toBe("État du Sénégal");
    expect(d.issuerType).toBe("souverain");
    expect(d.couponPct).toBe(6.75);
    expect(d.issueDate.startsWith("2025")).toBe(true);
    expect(d.maturityDate.startsWith("2032")).toBe(true);
    expect(d.datesEstimated).toBe(true);
    const t = defFromLabel("TPCI.O38", "TPCI 5,75 2019-2026 F"); // taux sans signe %
    expect(t.couponPct).toBe(5.75);
    const f = defFromLabel("FSNTS.O1", "FCTC SONATEL C-1 6,40% 2023 – 2028"); // tiret long
    expect(f.couponPct).toBe(6.4);
    expect(f.maturityDate.startsWith("2028")).toBe(true);
    expect(f.issuerType).toBe("entreprise");
    const u = defFromLabel("XYZ.O1", "SOCIETE INCONNUE 7,00% 2024-2030");
    expect(u.issuer).toBe("SOCIETE INCONNUE");
    expect(u.issuerType).toBe("entreprise");
  });
  it("analyse une page HTML de la cote", () => {
    const html = `<table><tr><th>#</th><th>Symbole</th></tr>
      <tr><td>1</td><td></td><td>TPCI.O69</td><td>TPCI 5,75% 2022-2037</td><td>100</td><td>100</td><td>0</td><td>0%</td><td>12</td><td>0</td><td>0</td><td>Non</td></tr>
      <tr><td>2</td><td></td><td>EOS.O9</td><td>ETAT DU SENEGAL 6% 2023-2028</td><td>95</td><td>96</td><td>0</td><td>-1%</td><td>0</td><td>0</td><td>0</td><td>Oui</td></tr></table>`;
    const rows = parseCoteHtml(html);
    expect(rows.map((r) => [r.code, r.closePct, r.prevPct, r.volume, r.suspended])).toEqual([["TPCI.O69", 100, 100, 12, false], ["EOS.O9", 95, 96, 0, true]]);
  });
});

describe("compartiment obligataire", () => {
  it("amorce le référentiel depuis la cote, cote en % du nominal et écarte les lignes échues", () => {
    const svc = new BondService(openMemoryDb());
    const list = svc.list();
    expect(list.length).toBeGreaterThan(25);
    expect(list.some((v) => v.code === "TPCI.O39")).toBe(false); // échue, sans cours
    expect(list.some((v) => v.code === "EOS.O17")).toBe(true);
    const eos = svc.view("EOS.O17")!;
    expect(eos.quote.pricePct).toBe(92);
    expect(eos.quote.source).toBe("brvm");
    expect(eos.quote.price).toBeCloseTo(9200, 0);
    expect(eos.analytics.ytmPct).toBeGreaterThan(6.65); // décote → rendement > coupon
    for (const v of list) {
      expect(v.quote.pricePct).toBeGreaterThan(50);
      expect(v.quote.pricePct).toBeLessThan(200);
      expect(v.analytics.ytmPct).toBeGreaterThan(-20); // un cours officiel très au-dessus du pair (ex. 131 %) peut donner un rendement négatif
    }
    expect(svc.history("TPCI.O69", 100).length).toBeGreaterThan(90);
    expect(svc.detail("TPCI.O69")!.flows.length).toBeGreaterThan(0);
    expect(svc.status().total).toBe(list.length);
  });
  it("désactive l'ancien référentiel fictif et remplace ses codes par la cote officielle", () => {
    const db = openMemoryDb();
    db.prepare("INSERT INTO bonds(code, name, issuer, issuer_type, country, coupon_pct, issue_date, maturity_date, nominal, frequency, amortization, grace_years, tax_exempt, active, source) VALUES ('BOAD.O30','BOAD 5,95 % 2023-2030','BOAD','supranational','TG',5.95,'2023-10-12','2030-10-12',10000,1,'in_fine',0,0,1,'seed')").run();
    db.prepare("INSERT INTO bonds(code, name, issuer, issuer_type, country, coupon_pct, issue_date, maturity_date, nominal, frequency, amortization, grace_years, tax_exempt, active, source) VALUES ('TPCI.O28','TPCI 6,00 % 2023-2028','TPCI','souverain','CI',6,'2023-06-15','2028-06-15',10000,2,'constant',2,1,1,'seed')").run();
    const svc = new BondService(db);
    expect(svc.def("BOAD.O30")!.active).toBe(false);
    expect(svc.def("TPCI.O28")!.name).toBe("TPCI 6% 2018-2026 A"); // libellé officiel
  });
  it("importe un tableau collé, accepte un prix officiel saisi et une émission précisée", () => {
    const svc = new BondService(openMemoryDb());
    const r = svc.importCote("46\t\tTPCI.O80\tTPCI 6% 2023-2030\t101\t100\t0\t1%\t20\t0\t101\tNon\t12:47:00\nligne sans symbole");
    expect(r.inserted).toBe(1);
    expect(r.unrecognized).toBe(1);
    expect(svc.view("TPCI.O80")!.quote.pricePct).toBe(101);
    const v = svc.setPrice("EOS.O17", 93.5);
    expect(v.quote.pricePct).toBe(93.5);
    expect(v.quote.source).toBe("admin");
    const n = svc.upsert({ code: "EOS.O17", name: "Etat du Sénégal 6,65% 2024-2034", issuer: "État du Sénégal", issuerType: "souverain", country: "SN", couponPct: 6.65, issueDate: "2024-07-15", maturityDate: "2034-07-15", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 3, taxExempt: true });
    expect(n.datesEstimated).toBe(false);
    expect(n.source).toBe("admin");
    // une nouvelle cote ne doit pas écraser les dates précisées par l'administrateur
    svc.applyCote(parseCoteText("1\t\tEOS.O17\tEtat du Sénégal 6,65% 2024-2034\t94\t93\t0\t0%\t0\t0\t0\tNon"), "brvm");
    expect(svc.def("EOS.O17")!.issueDate).toBe("2024-07-15");
    expect(svc.view("EOS.O17")!.quote.pricePct).toBe(94);
    svc.deactivate("TPCI.O80");
    expect(svc.list().some((x) => x.code === "TPCI.O80")).toBe(false);
  });
  it("collecte la cote via une page HTML (fetch factice) et signale les échecs", async () => {
    const html = `<table><tr><td>1</td><td></td><td>BOAD.O14</td><td>BOAD 5,95% 2024-2031</td><td>100</td><td>100</td><td>0</td><td>0%</td><td>0</td><td>0</td><td>0</td><td>Non</td></tr></table>`;
    const fetchImpl = (async (url: string) => (String(url).includes("page=") ? new Response("<table></table>", { status: 200 }) : new Response(html, { status: 200 }))) as unknown as typeof fetch;
    const svc = new BondService(openMemoryDb(), fetchImpl);
    const run = await svc.refresh();
    expect(run!.ok).toBe(true);
    expect(run!.rows).toBe(1);
    expect(svc.view("BOAD.O14")!.issuer).toContain("Banque Ouest Africaine");
    const ko = new BondService(openMemoryDb(), (async () => new Response("", { status: 503 })) as unknown as typeof fetch);
    const r2 = await ko.refresh();
    expect(r2!.ok).toBe(false);
    expect(r2!.error).toMatch(/503/);
  });
});
