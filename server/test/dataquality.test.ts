import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { INSTRUMENTS } from "../src/data/instruments.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { BocService } from "../src/services/boc.js";
import { BondService } from "../src/services/bonds.js";
import { CorporateService } from "../src/services/corporate.js";
import { NewsService } from "../src/services/news.js";
import { DataQualityService, lastClosedSession } from "../src/services/dataquality.js";
import fs from "node:fs";
import path from "node:path";

const utc = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);

async function setup() {
  const db = openMemoryDb();
  ensureHistoryDepth(db, 80);
  const market = new MarketService(db);
  const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void };
  await m.loadOrSeedHistory();
  for (const inst of INSTRUMENTS) m.initSnapshot(inst);
  const bonds = new BondService(db);
  const corporate = new CorporateService(db, market);
  const news = new NewsService(db);
  const boc = new BocService(db, market, (async () => new Response("", { status: 404 })) as unknown as typeof fetch);
  boc.attach(bonds, corporate, news);
  const dq = new DataQualityService(db, market);
  dq.attach({ boc, corporate, bonds, news });
  return { db, market, boc, corporate, dq };
}

describe("contrôle de qualité des données", () => {
  it("dernière séance close : jour ouvré après 15 h UTC, sinon le jour ouvré précédent", () => {
    expect(lastClosedSession(utc(2026, 11, 12, 16))).toBe(utc(2026, 11, 12)); // jeudi 16 h
    expect(lastClosedSession(utc(2026, 11, 12, 10))).toBe(utc(2026, 11, 11)); // jeudi matin
    expect(lastClosedSession(utc(2026, 11, 15, 12))).toBe(utc(2026, 11, 13)); // dimanche → vendredi
  });

  it("sans historique réel ni bulletin : constats de fraîcheur, score borné, diff vide au premier passage", async () => {
    const { dq } = await setup();
    const run = dq.runChecks(utc(2026, 11, 12, 18));
    expect(run.score).toBeGreaterThanOrEqual(0);
    expect(run.score).toBeLessThanOrEqual(100);
    expect(run.findings.some((f) => f.check === "fraicheur_historique" && /synthétique/.test(f.message))).toBe(true);
    expect(run.findings.some((f) => f.check === "fraicheur_bulletin")).toBe(true);
    expect(run.checks).toHaveLength(10);
    expect(run.changes.added.length).toBe(run.findings.length);
    expect(run.changes.resolved).toEqual([]);
    expect(dq.latestRun()?.id).toBe(run.id);
    expect(dq.scoreHistory()).toHaveLength(1);
  });

  it("détecte un écart bulletin / cours en base, un dividende exceptionnel et une variation hors limite, puis les résolutions", async () => {
    const { db, market, boc, corporate, dq } = await setup();
    const text = fs.readFileSync(path.join(__dirname, "fixtures", "boc_brvm_sample.txt"), "utf8");
    boc.importText(text, null, "brvm:test");
    const session = utc(2026, 11, 11);
    // on fausse la clôture en base de SNTS (bulletin : 4 190) et on marque la séance comme réelle
    db.prepare("UPDATE candles SET close = 4600, source = 'sika' WHERE symbol = 'SNTS' AND ts = ?").run(session);
    db.prepare("UPDATE candles SET source = 'sika' WHERE symbol = 'SNTS' AND ts = ?").run(utc(2026, 11, 10));
    (market as unknown as { candles: Map<string, { ts: number; close: number }[]> }).candles.get("SNTS")!.find((c) => c.ts === session)!.close = 4600;
    corporate.upsertDividend({ symbol: "SICC", fiscalYear: 2025, net: 5000, status: "payé" }, 1);
    const run = dq.runChecks(utc(2026, 11, 12, 18));
    const coherence = run.findings.find((f) => f.check === "coherence_cours" && f.symbol === "SNTS");
    expect(coherence?.severity).toBe("error");
    expect(coherence?.value).toBeGreaterThan(5);
    expect(run.findings.some((f) => f.check === "dividendes" && f.symbol === "SICC" && /exceptionnel/.test(f.message))).toBe(true);
    const moves = run.findings.filter((f) => f.check === "variation_limite" && f.symbol === "SNTS");
    expect(moves.length).toBeGreaterThanOrEqual(1);
    expect(run.errors).toBeGreaterThanOrEqual(1);
    // correction : le second passage voit le constat résolu
    db.prepare("UPDATE candles SET close = 4190 WHERE symbol = 'SNTS' AND ts = ?").run(session);
    const again = dq.runChecks(utc(2026, 11, 12, 19));
    expect(again.findings.some((f) => f.check === "coherence_cours" && f.symbol === "SNTS")).toBe(false);
    expect(again.changes.resolved.some((f) => f.key === coherence!.key)).toBe(true);
    expect(again.score).toBeGreaterThan(run.score);
  });

  it("rapport du jour : place, qualité, modèles absents, changements à partir du second jour", async () => {
    const { dq } = await setup();
    dq.runChecks(utc(2026, 11, 11, 18));
    const r1 = dq.dailyReport(utc(2026, 11, 11, 18));
    expect(r1.date).toBe(utc(2026, 11, 11));
    expect(r1.market.advancers + r1.market.decliners + r1.market.unchanged).toBe(INSTRUMENTS.length);
    expect(r1.quality?.score).toBeDefined();
    expect(r1.holdings).toBeNull();
    expect(r1.changes).toEqual([]);
    const r2 = dq.dailyReport(utc(2026, 11, 12, 18));
    expect(dq.reports().map((r) => r.date)).toEqual([utc(2026, 11, 12), utc(2026, 11, 11)]);
    expect(dq.latestReport(utc(2026, 11, 11))?.date).toBe(utc(2026, 11, 11));
    expect(Array.isArray(r2.changes)).toBe(true);
    expect(dq.status().lastReport).toBe(utc(2026, 11, 12));
  });
});
