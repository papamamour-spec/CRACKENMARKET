import type { DB } from "../db/index.js";
import { INSTRUMENT_MAP } from "../data/instruments.js";
import type { MarketService } from "./market.js";
import { pctChange } from "../engine/indicators.js";

export interface Portfolio {
  id: number;
  userId: number;
  name: string;
  cash: number;
  initialCash: number;
  createdAt: number;
}

export interface PositionView {
  symbol: string;
  name: string;
  sector: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  marketValue: number;
  costBasis: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  weightPct: number;
  dayChangePct: number;
}

export interface OrderInput {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: number;
  limitPrice?: number;
  note?: string;
}

export interface OrderRow {
  id: number;
  portfolio_id: number;
  user_id: number;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: number;
  limit_price: number | null;
  status: string;
  filled_price: number | null;
  filled_at: number | null;
  created_at: number;
  note: string | null;
}

const FEE_RATE = 0.0125; // courtage + frais BRVM/DC-BR approximatifs

export class PortfolioService {
  constructor(
    private readonly db: DB,
    private readonly market: MarketService,
  ) {}

  getForUser(userId: number): Portfolio {
    const row = this.db.prepare("SELECT * FROM portfolios WHERE user_id = ? ORDER BY id LIMIT 1").get(userId) as
      | { id: number; user_id: number; name: string; cash: number; initial_cash: number; created_at: number }
      | undefined;
    if (!row) throw new Error("Portefeuille introuvable");
    return { id: row.id, userId: row.user_id, name: row.name, cash: row.cash, initialCash: row.initial_cash, createdAt: row.created_at };
  }

  positions(portfolioId: number): PositionView[] {
    const rows = this.db.prepare("SELECT symbol, quantity, avg_price FROM positions WHERE portfolio_id = ? AND quantity > 0").all(portfolioId) as {
      symbol: string;
      quantity: number;
      avg_price: number;
    }[];
    const views = rows.map((r) => {
      const inst = INSTRUMENT_MAP.get(r.symbol);
      const snap = this.market.snapshot(r.symbol);
      const price = snap?.price ?? r.avg_price;
      const mv = price * r.quantity;
      const cost = r.avg_price * r.quantity;
      return {
        symbol: r.symbol,
        name: inst?.name ?? r.symbol,
        sector: inst?.sector ?? "",
        quantity: r.quantity,
        avgPrice: r.avg_price,
        currentPrice: price,
        marketValue: mv,
        costBasis: cost,
        unrealizedPnl: mv - cost,
        unrealizedPnlPct: cost ? ((mv - cost) / cost) * 100 : 0,
        weightPct: 0,
        dayChangePct: snap?.changePct ?? 0,
      };
    });
    const total = views.reduce((a, v) => a + v.marketValue, 0);
    for (const v of views) v.weightPct = total ? (v.marketValue / total) * 100 : 0;
    return views.sort((a, b) => b.marketValue - a.marketValue);
  }

  summary(userId: number) {
    const pf = this.getForUser(userId);
    const positions = this.positions(pf.id);
    const invested = positions.reduce((a, p) => a + p.marketValue, 0);
    const realized = (this.db.prepare("SELECT COALESCE(SUM(realized_pnl),0) AS s FROM trades WHERE portfolio_id = ?").get(pf.id) as { s: number }).s;
    const totalValue = pf.cash + invested;
    return {
      portfolio: pf,
      positions,
      invested,
      totalValue,
      totalPnl: totalValue - pf.initialCash,
      totalPnlPct: pf.initialCash ? ((totalValue - pf.initialCash) / pf.initialCash) * 100 : 0,
      realizedPnl: realized,
      unrealizedPnl: positions.reduce((a, p) => a + p.unrealizedPnl, 0),
    };
  }

  orders(userId: number, limit = 100): OrderRow[] {
    return this.db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit) as OrderRow[];
  }

  trades(userId: number, limit = 500) {
    return this.db
      .prepare("SELECT symbol, side, quantity, price, realized_pnl AS realizedPnl, ts FROM trades WHERE user_id = ? ORDER BY ts DESC LIMIT ?")
      .all(userId, limit) as { symbol: string; side: "buy" | "sell"; quantity: number; price: number; realizedPnl: number; ts: number }[];
  }

  /** Passe un ordre (exécution immédiate au cours pour un ordre marché ; ordre limite exécuté si compatible, sinon laissé ouvert). */
  placeOrder(userId: number, input: OrderInput): OrderRow {
    const inst = INSTRUMENT_MAP.get(input.symbol);
    if (!inst) throw new Error("Valeur inconnue");
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error("Quantité invalide");
    const pf = this.getForUser(userId);
    const now = Date.now();
    const snap = this.market.snapshot(input.symbol);
    const mkt = snap?.price ?? inst.refPrice;
    let execPrice: number | null = null;
    if (input.type === "market") execPrice = mkt;
    else {
      if (!input.limitPrice || input.limitPrice <= 0) throw new Error("Prix limite requis");
      if (input.side === "buy" && mkt <= input.limitPrice) execPrice = mkt;
      if (input.side === "sell" && mkt >= input.limitPrice) execPrice = mkt;
    }

    const insertOrder = this.db.prepare(
      "INSERT INTO orders(portfolio_id, user_id, symbol, side, type, quantity, limit_price, status, filled_price, filled_at, created_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const tx = this.db.transaction((): number => {
      if (execPrice === null) {
        const info = insertOrder.run(pf.id, userId, input.symbol, input.side, input.type, input.quantity, input.limitPrice ?? null, "open", null, null, now, input.note ?? null);
        return Number(info.lastInsertRowid);
      }
      const gross = execPrice * input.quantity;
      const fee = gross * FEE_RATE;
      const pos = this.db.prepare("SELECT quantity, avg_price FROM positions WHERE portfolio_id = ? AND symbol = ?").get(pf.id, input.symbol) as
        | { quantity: number; avg_price: number }
        | undefined;
      let realized = 0;
      if (input.side === "buy") {
        if (pf.cash < gross + fee) throw new Error(`Liquidités insuffisantes (${Math.round(gross + fee).toLocaleString("fr-FR")} FCFA requis)`);
        this.db.prepare("UPDATE portfolios SET cash = cash - ? WHERE id = ?").run(gross + fee, pf.id);
        const newQty = (pos?.quantity ?? 0) + input.quantity;
        const newAvg = ((pos?.quantity ?? 0) * (pos?.avg_price ?? 0) + gross + fee) / newQty;
        this.db
          .prepare("INSERT INTO positions(portfolio_id, symbol, quantity, avg_price) VALUES (?,?,?,?) ON CONFLICT(portfolio_id, symbol) DO UPDATE SET quantity = excluded.quantity, avg_price = excluded.avg_price")
          .run(pf.id, input.symbol, newQty, newAvg);
      } else {
        if (!pos || pos.quantity < input.quantity) throw new Error("Quantité détenue insuffisante");
        this.db.prepare("UPDATE portfolios SET cash = cash + ? WHERE id = ?").run(gross - fee, pf.id);
        realized = (execPrice - pos.avg_price) * input.quantity - fee;
        const remaining = pos.quantity - input.quantity;
        if (remaining === 0) this.db.prepare("DELETE FROM positions WHERE portfolio_id = ? AND symbol = ?").run(pf.id, input.symbol);
        else this.db.prepare("UPDATE positions SET quantity = ? WHERE portfolio_id = ? AND symbol = ?").run(remaining, pf.id, input.symbol);
      }
      const info = insertOrder.run(pf.id, userId, input.symbol, input.side, input.type, input.quantity, input.limitPrice ?? null, "filled", execPrice, now, now, input.note ?? null);
      const orderId = Number(info.lastInsertRowid);
      this.db
        .prepare("INSERT INTO trades(order_id, portfolio_id, user_id, symbol, side, quantity, price, realized_pnl, ts) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(orderId, pf.id, userId, input.symbol, input.side, input.quantity, execPrice, realized, now);
      this.recordBehavior(userId, input, now);
      return orderId;
    });
    const id = tx();
    return this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow;
  }

  /** Annote le comportement : achat après forte hausse, vente après forte baisse. */
  private recordBehavior(userId: number, input: OrderInput, now: number): void {
    const hist = this.market.history(input.symbol, 10).map((c) => c.close);
    const perf5 = pctChange(hist, 5);
    const insert = this.db.prepare("INSERT INTO behavior_events(user_id, kind, symbol, payload, ts) VALUES (?,?,?,?,?)");
    insert.run(userId, "order", input.symbol, JSON.stringify({ side: input.side, perf5 }), now);
    if (input.side === "buy" && perf5 > 8) insert.run(userId, "order_chasing", input.symbol, JSON.stringify({ perf5 }), now);
    if (input.side === "sell" && perf5 < -6) insert.run(userId, "order_panic", input.symbol, JSON.stringify({ perf5 }), now);
  }

  cancelOrder(userId: number, orderId: number): void {
    const info = this.db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'open'").run(orderId, userId);
    if (info.changes === 0) throw new Error("Ordre introuvable ou non annulable");
  }

  /** Exécute les ordres limites ouverts devenus exécutables (appelé à chaque tick). */
  matchOpenOrders(symbols: string[]): OrderRow[] {
    if (!symbols.length) return [];
    const placeholders = symbols.map(() => "?").join(",");
    const open = this.db.prepare(`SELECT * FROM orders WHERE status = 'open' AND symbol IN (${placeholders})`).all(...symbols) as OrderRow[];
    const filled: OrderRow[] = [];
    for (const o of open) {
      const mkt = this.market.price(o.symbol);
      const ok = (o.side === "buy" && mkt <= (o.limit_price ?? 0)) || (o.side === "sell" && mkt >= (o.limit_price ?? Infinity));
      if (!ok) continue;
      try {
        this.db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o.id);
        const f = this.placeOrder(o.user_id, { symbol: o.symbol, side: o.side, type: "market", quantity: o.quantity, note: `Exécution ordre limite #${o.id}` });
        filled.push(f);
      } catch (e) {
        this.db.prepare("UPDATE orders SET status = 'rejected', note = ? WHERE id = ?").run((e as Error).message, o.id);
      }
    }
    return filled;
  }
}
