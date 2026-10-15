import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { BOND_MAP } from "../src/data/bonds.js";
import { accruedInterest, analyzeBond, cleanPrice, dirtyPrice, fullSchedule, remainingCashFlows, yieldFromCleanPrice } from "../src/engine/bonds.js";
import { BondService } from "../src/services/bonds.js";

const b = BOND_MAP.get("TPCI.O30")!; // 6,15 %, semestriel, différé 3 ans, amortissement constant
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
    const boad = BOND_MAP.get("BOAD.O30")!;
    const s = fullSchedule(boad);
    expect(s.slice(0, -1).every((f) => f.principal === 0)).toBe(true);
    expect(s[s.length - 1].principal).toBe(10000);
  });
});

describe("compartiment obligataire", () => {
  it("amorce le référentiel, cote et classe les obligations", () => {
    const svc = new BondService(openMemoryDb());
    const list = svc.list();
    expect(list.length).toBeGreaterThan(10);
    for (const v of list) {
      // le prix porte sur le capital restant dû (amortissement partiel déjà remboursé)
      expect(v.quote.price).toBeGreaterThan(v.analytics.outstanding * 0.85);
      expect(v.quote.price).toBeLessThan(v.analytics.outstanding * 1.15);
      expect(v.analytics.ytmPct).toBeGreaterThan(3);
      expect(v.analytics.ytmPct).toBeLessThan(12);
    }
    const h = svc.history("TPCI.O30", 100);
    expect(h.length).toBeGreaterThan(90);
    const d = svc.detail("TPCI.O30")!;
    expect(d.schedule.length).toBe(14);
    expect(d.flows.length).toBeGreaterThan(0);
  });
  it("accepte un prix officiel saisi et une nouvelle émission", () => {
    const svc = new BondService(openMemoryDb());
    const v = svc.setPrice("TPCI.O30", 9950);
    expect(v.quote.price).toBe(9950);
    expect(v.quote.source).toBe("manuel");
    const n = svc.upsert({ code: "TEST.O35", name: "Test 7 % 2025-2035", issuer: "Test", issuerType: "entreprise", country: "CI", couponPct: 7, issueDate: "2025-01-01", maturityDate: "2035-01-01", nominal: 10000, frequency: 1, amortization: "in_fine", graceYears: 0, taxExempt: false });
    expect(n.code).toBe("TEST.O35");
    expect(svc.list().some((x) => x.code === "TEST.O35")).toBe(true);
    svc.deactivate("TEST.O35");
    expect(svc.list().some((x) => x.code === "TEST.O35")).toBe(false);
  });
});
