import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { ensureHistoryDepth } from "../src/services/market.js";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../src/data/instruments.js";
import { HISTORY_YEARS_DEFAULT, TRADING_DAYS_PER_YEAR, config } from "../src/config.js";

describe("profondeur d'historique", () => {
  it("la profondeur par défaut couvre 5 ans de séances", () => {
    expect(HISTORY_YEARS_DEFAULT).toBe(5);
    expect(config.historyDays).toBe(5 * TRADING_DAYS_PER_YEAR);
  });

  it("l'ancrage et la date de fin sont paramétrables", () => {
    const inst = INSTRUMENT_MAP.get("SNTS")!;
    const end = new Date(Date.UTC(2024, 0, 12)); // vendredi
    const candles = generateDailyHistory(inst, 30, end, 12345, 1);
    expect(candles.length).toBe(30);
    expect(candles[candles.length - 1].close).toBe(12345);
    expect(candles[candles.length - 1].ts).toBe(end.getTime());
    for (let i = 1; i < candles.length; i++) expect(candles[i].ts).toBeGreaterThan(candles[i - 1].ts);
    expect(generateDailyHistory(inst, 0)).toEqual([]);
  });

  it("remplit une base vide puis prolonge une base plus courte sans rupture", () => {
    const db = openMemoryDb();
    const count = db.prepare("SELECT COUNT(*) AS n FROM candles WHERE symbol = ?");
    const first = ensureHistoryDepth(db, 100);
    expect(first).toBe(100 * INSTRUMENTS.length);
    const before = db
      .prepare("SELECT ts, open FROM candles WHERE symbol = ? ORDER BY ts LIMIT 1")
      .get("SNTS") as { ts: number; open: number };
    // Rien à faire si la profondeur est déjà atteinte
    expect(ensureHistoryDepth(db, 100)).toBe(0);
    // Extension : 50 séances supplémentaires avant la plus ancienne, pour chaque valeur
    const added = ensureHistoryDepth(db, 150);
    expect(added).toBe(50 * INSTRUMENTS.length);
    expect((count.get("SNTS") as { n: number }).n).toBe(150);
    const rows = db.prepare("SELECT ts, open, close FROM candles WHERE symbol = ? ORDER BY ts").all("SNTS") as {
      ts: number;
      open: number;
      close: number;
    }[];
    expect(rows.length).toBe(150);
    const junction = rows.findIndex((r) => r.ts === before.ts);
    expect(junction).toBe(50);
    // La dernière bougie prolongée ferme au cours d'ouverture de l'ancienne première bougie
    expect(rows[junction - 1].close).toBe(before.open);
    expect(rows[junction - 1].ts).toBeLessThan(before.ts);
    // Le prix de référence actuel reste le dernier close
    expect(rows[rows.length - 1].close).toBe(INSTRUMENT_MAP.get("SNTS")!.refPrice);
  });
});

import { MarketService } from "../src/services/market.js";

describe("variations par période", () => {
  it("calcule 1D vs veille, 1W/1M vs clôtures passées, YTD et 52 semaines", async () => {
    process.env.DATA_PROVIDER = "simulation";
    const db = openMemoryDb();
    const market = new MarketService(db);
    await market.start();
    try {
      const s = market.snapshot("SNTS")!;
      expect(s.perf["1D"]).toBeCloseTo(((s.price - s.prevClose) / s.prevClose) * 100, 1);
      const hist = market.history("SNTS", 2000);
      const today = new Date().setUTCHours(0, 0, 0, 0);
      const closes = hist.filter((c) => c.ts < today);
      expect(s.perf["1W"]).toBeCloseTo((s.price / closes[closes.length - 5].close - 1) * 100, 1);
      expect(s.perf["1Y"]).not.toBeNull();
      expect(s.perf.YTD).not.toBeNull();
      expect(s.high52).toBeGreaterThanOrEqual(s.price);
      expect(s.low52).toBeLessThanOrEqual(s.price);
    } finally {
      market.stop();
    }
  });
});
