import { beforeEach, describe, expect, it } from "vitest";
import { openMemoryDb, type DB } from "../src/db/index.js";
import { AuthService } from "../src/services/auth.js";
import { PortfolioService } from "../src/services/portfolio.js";
import { buildOrderBook } from "../src/services/orderbook.js";
import { INSTRUMENT_MAP } from "../src/data/instruments.js";
import type { MarketService } from "../src/services/market.js";

/** Marché factice : prix pilotés par le test. */
function fakeMarket(prices: Record<string, number>) {
  return {
    price: (s: string) => prices[s] ?? 0,
    snapshot: (s: string) => (prices[s] ? { symbol: s, price: prices[s], changePct: 0 } : undefined),
    history: () => [],
    indexHistory: () => [],
  } as unknown as MarketService;
}

describe("ordres avancés", () => {
  let db: DB;
  let prices: Record<string, number>;
  let pf: PortfolioService;
  let userId: number;

  beforeEach(() => {
    db = openMemoryDb();
    prices = { SNTS: 22000, ORAC: 13000 };
    pf = new PortfolioService(db, fakeMarket(prices));
    userId = new AuthService(db).register("t@ex.com", "secret123", "Test User").id;
  });

  it("ordre marché exécuté, puis stop de vente déclenché à la baisse", () => {
    const buy = pf.placeOrder(userId, { symbol: "SNTS", side: "buy", type: "market", quantity: 10 });
    expect(buy.status).toBe("filled");
    const stop = pf.placeOrder(userId, { symbol: "SNTS", side: "sell", type: "stop", quantity: 10, stopPrice: 21000 });
    expect(stop.status).toBe("open");
    prices.SNTS = 21500;
    expect(pf.matchOpenOrders(["SNTS"])).toHaveLength(0);
    prices.SNTS = 20900;
    const filled = pf.matchOpenOrders(["SNTS"]);
    expect(filled).toHaveLength(1);
    expect(filled[0].filled_price).toBe(20900);
    expect(pf.positions(pf.getForUser(userId).id)).toHaveLength(0);
  });

  it("refuse un stop mal placé", () => {
    expect(() => pf.placeOrder(userId, { symbol: "SNTS", side: "buy", type: "stop", quantity: 1, stopPrice: 21000 })).toThrow(/au-dessus/);
  });

  it("stop-limite : déclenché puis exécuté seulement si la limite est respectée", () => {
    pf.placeOrder(userId, { symbol: "SNTS", side: "buy", type: "market", quantity: 5 });
    pf.placeOrder(userId, { symbol: "SNTS", side: "sell", type: "stop_limit", quantity: 5, stopPrice: 21000, limitPrice: 20800 });
    prices.SNTS = 20500; // sous le stop ET sous la limite : déclenché mais pas exécuté
    expect(pf.matchOpenOrders(["SNTS"])).toHaveLength(0);
    const o = pf.orders(userId).find((x) => x.type === "stop_limit")!;
    expect(o.triggered_at).not.toBeNull();
    prices.SNTS = 20900; // au-dessus de la limite : exécution
    expect(pf.matchOpenOrders(["SNTS"])).toHaveLength(1);
  });

  it("bracket : l'achat crée un objectif et un stop liés, l'un annule l'autre", () => {
    const buy = pf.placeOrder(userId, { symbol: "ORAC", side: "buy", type: "market", quantity: 10, takeProfit: 14000, stopLoss: 12000 });
    expect(buy.status).toBe("filled");
    const open = pf.orders(userId).filter((o) => o.status === "open");
    expect(open).toHaveLength(2);
    expect(open.every((o) => o.oco_group === `oco-${buy.id}`)).toBe(true);
    prices.ORAC = 14100;
    const filled = pf.matchOpenOrders(["ORAC"]);
    expect(filled).toHaveLength(1);
    expect(filled[0].type).toBe("limit");
    const statuses = pf.orders(userId).map((o) => o.status).sort();
    expect(statuses).toEqual(["cancelled", "filled", "filled"]);
    expect(pf.summary(userId).realizedPnl).toBeGreaterThan(0);
  });

  it("un ordre « jour » expire le lendemain", () => {
    pf.placeOrder(userId, { symbol: "SNTS", side: "buy", type: "limit", quantity: 1, limitPrice: 20000, validity: "day" });
    db.prepare("UPDATE orders SET created_at = created_at - 2 * 86400000").run();
    pf.matchOpenOrders(["SNTS"]);
    expect(pf.orders(userId)[0].status).toBe("expired");
  });

  it("instantanés et performance", () => {
    pf.placeOrder(userId, { symbol: "SNTS", side: "buy", type: "market", quantity: 10 });
    expect(pf.snapshotAll()).toBeGreaterThan(0);
    const perf = pf.performance(userId, 30);
    expect(perf.series.length).toBeGreaterThan(0);
    expect(perf.stats.trades).toBe(1);
    expect(pf.tradesCsv(userId).split("\n")).toHaveLength(2);
  });
});

describe("carnet d'ordres", () => {
  it("produit des niveaux cohérents autour du cours", () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const book = buildOrderBook(INSTRUMENT_MAP.get("SNTS")!, 22000, rand);
    expect(book.bids[0].price).toBeLessThan(22000);
    expect(book.asks[0].price).toBeGreaterThan(22000);
    expect(book.bids[0].price).toBeGreaterThan(book.bids[4].price);
    expect(book.asks[0].price).toBeLessThan(book.asks[4].price);
    expect(book.spread).toBeGreaterThan(0);
    expect(Math.abs(book.imbalance)).toBeLessThanOrEqual(1);
  });
});
