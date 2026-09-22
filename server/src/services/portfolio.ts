import type { DB } from "../db/index.js";
import { INSTRUMENT_MAP } from "../data/instruments.js";
import { pctChange } from "../engine/indicators.js";
import { startOfDayUtc, type MarketService } from "./market.js";

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

export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type OrderValidity = "day" | "gtc";

export interface OrderInput {
  symbol: string;
  side: "buy" | "sell";
  type: OrderType;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  validity?: OrderValidity;
  /** Ordres liés (bracket) : après exécution d'un achat, pose un objectif (limite) et un stop de protection, en OCO. */
  takeProfit?: number;
  stopLoss?: number;
  note?: string;
  ocoGroup?: string;
}

export interface OrderRow {
  id: number;
  portfolio_id: number;
  user_id: number;
  symbol: string;
  side: "buy" | "sell";
  type: OrderType;
  quantity: number;
  limit_price: number | null;
  stop_price: number | null;
  validity: OrderValidity;
  oco_group: string | null;
  take_profit: number | null;
  stop_loss: number | null;
  triggered_at: number | null;
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
    return this.db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(userId, limit) as OrderRow[];
  }

  trades(userId: number, limit = 500) {
    return this.db
      .prepare("SELECT symbol, side, quantity, price, realized_pnl AS realizedPnl, ts FROM trades WHERE user_id = ? ORDER BY ts DESC LIMIT ?")
      .all(userId, limit) as { symbol: string; side: "buy" | "sell"; quantity: number; price: number; realizedPnl: number; ts: number }[];
  }

  /**
   * Passe un ordre. Les ordres marché sont exécutés immédiatement ; limite, stop et stop-limite
   * sont exécutés si la condition est déjà remplie, sinon laissés ouverts et surveillés à chaque tick.
   * Un achat avec `takeProfit` / `stopLoss` crée après exécution deux ordres de vente liés (OCO).
   */
  placeOrder(userId: number, input: OrderInput): OrderRow {
    const inst = INSTRUMENT_MAP.get(input.symbol);
    if (!inst) throw new Error("Valeur inconnue");
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error("Quantité invalide");
    const pf = this.getForUser(userId);
    const now = Date.now();
    const mkt = this.market.snapshot(input.symbol)?.price ?? inst.refPrice;
    if ((input.type === "limit" || input.type === "stop_limit") && !(input.limitPrice && input.limitPrice > 0)) throw new Error("Prix limite requis");
    if ((input.type === "stop" || input.type === "stop_limit") && !(input.stopPrice && input.stopPrice > 0)) throw new Error("Prix de déclenchement requis");
    if (input.type === "stop" || input.type === "stop_limit") {
      if (input.side === "buy" && input.stopPrice! <= mkt) throw new Error("Un stop d'achat doit être au-dessus du cours actuel");
      if (input.side === "sell" && input.stopPrice! >= mkt) throw new Error("Un stop de vente doit être en dessous du cours actuel");
    }
    if (input.side === "buy") {
      if (input.takeProfit !== undefined && input.takeProfit <= mkt) throw new Error("L'objectif doit être au-dessus du cours actuel");
      if (input.stopLoss !== undefined && input.stopLoss >= mkt) throw new Error("Le stop de protection doit être en dessous du cours actuel");
    }
    const execPrice = this.executablePrice({ ...input, triggered: false }, mkt);
    const tx = this.db.transaction((): number => {
      const id = this.insertOrder(pf.id, userId, input, now);
      if (execPrice !== null) this.fill(id, execPrice, now);
      return id;
    });
    const id = tx();
    return this.getOrder(id);
  }

  private insertOrder(portfolioId: number, userId: number, input: OrderInput, now: number): number {
    const info = this.db
      .prepare(
        `INSERT INTO orders(portfolio_id, user_id, symbol, side, type, quantity, limit_price, stop_price, validity, oco_group, take_profit, stop_loss, status, created_at, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`,
      )
      .run(portfolioId, userId, input.symbol, input.side, input.type, input.quantity, input.limitPrice ?? null, input.stopPrice ?? null, input.validity ?? "gtc", input.ocoGroup ?? null, input.takeProfit ?? null, input.stopLoss ?? null, now, input.note ?? null);
    return Number(info.lastInsertRowid);
  }

  /** Prix d'exécution si l'ordre est exécutable au cours `mkt`, sinon null. */
  private executablePrice(o: { type: OrderType; side: "buy" | "sell"; limitPrice?: number | null; stopPrice?: number | null; triggered: boolean }, mkt: number): number | null {
    const limitOk = () => (o.side === "buy" ? mkt <= (o.limitPrice ?? 0) : mkt >= (o.limitPrice ?? Infinity));
    const stopHit = () => (o.side === "buy" ? mkt >= (o.stopPrice ?? Infinity) : mkt <= (o.stopPrice ?? 0));
    switch (o.type) {
      case "market":
        return mkt;
      case "limit":
        return limitOk() ? mkt : null;
      case "stop":
        return stopHit() ? mkt : null;
      case "stop_limit":
        return (o.triggered || stopHit()) && limitOk() ? mkt : null;
    }
  }

  /** Exécute un ordre ouvert au prix donné : mouvements de liquidités, position, transaction, ordres liés. */
  private fill(orderId: number, execPrice: number, now: number): OrderRow {
    const o = this.getOrder(orderId);
    if (o.status !== "open") throw new Error("Ordre non ouvert");
    const pf = this.db.prepare("SELECT id, cash FROM portfolios WHERE id = ?").get(o.portfolio_id) as { id: number; cash: number };
    const gross = execPrice * o.quantity;
    const fee = gross * FEE_RATE;
    const pos = this.db.prepare("SELECT quantity, avg_price FROM positions WHERE portfolio_id = ? AND symbol = ?").get(pf.id, o.symbol) as
      | { quantity: number; avg_price: number }
      | undefined;
    let realized = 0;
    if (o.side === "buy") {
      if (pf.cash < gross + fee) throw new Error(`Liquidités insuffisantes (${Math.round(gross + fee).toLocaleString("fr-FR")} FCFA requis)`);
      this.db.prepare("UPDATE portfolios SET cash = cash - ? WHERE id = ?").run(gross + fee, pf.id);
      const newQty = (pos?.quantity ?? 0) + o.quantity;
      const newAvg = ((pos?.quantity ?? 0) * (pos?.avg_price ?? 0) + gross + fee) / newQty;
      this.db
        .prepare("INSERT INTO positions(portfolio_id, symbol, quantity, avg_price) VALUES (?,?,?,?) ON CONFLICT(portfolio_id, symbol) DO UPDATE SET quantity = excluded.quantity, avg_price = excluded.avg_price")
        .run(pf.id, o.symbol, newQty, newAvg);
    } else {
      if (!pos || pos.quantity < o.quantity) throw new Error("Quantité détenue insuffisante");
      this.db.prepare("UPDATE portfolios SET cash = cash + ? WHERE id = ?").run(gross - fee, pf.id);
      realized = (execPrice - pos.avg_price) * o.quantity - fee;
      const remaining = pos.quantity - o.quantity;
      if (remaining === 0) this.db.prepare("DELETE FROM positions WHERE portfolio_id = ? AND symbol = ?").run(pf.id, o.symbol);
      else this.db.prepare("UPDATE positions SET quantity = ? WHERE portfolio_id = ? AND symbol = ?").run(remaining, pf.id, o.symbol);
    }
    this.db.prepare("UPDATE orders SET status = 'filled', filled_price = ?, filled_at = ? WHERE id = ?").run(execPrice, now, orderId);
    this.db
      .prepare("INSERT INTO trades(order_id, portfolio_id, user_id, symbol, side, quantity, price, realized_pnl, ts) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(orderId, pf.id, o.user_id, o.symbol, o.side, o.quantity, execPrice, realized, now);
    this.recordBehavior(o.user_id, o.symbol, o.side, now);
    // OCO : l'exécution annule les ordres frères
    if (o.oco_group) this.db.prepare("UPDATE orders SET status = 'cancelled', note = 'Annulé (OCO)' WHERE oco_group = ? AND id != ? AND status = 'open'").run(o.oco_group, orderId);
    // Bracket : objectif + stop de protection après un achat
    if (o.side === "buy" && (o.take_profit || o.stop_loss)) {
      const group = `oco-${orderId}`;
      if (o.take_profit) this.insertOrder(pf.id, o.user_id, { symbol: o.symbol, side: "sell", type: "limit", quantity: o.quantity, limitPrice: o.take_profit, validity: "gtc", ocoGroup: group, note: `Objectif lié à l'ordre #${orderId}` }, now);
      if (o.stop_loss) this.insertOrder(pf.id, o.user_id, { symbol: o.symbol, side: "sell", type: "stop", quantity: o.quantity, stopPrice: o.stop_loss, validity: "gtc", ocoGroup: group, note: `Stop de protection lié à l'ordre #${orderId}` }, now);
    }
    return this.getOrder(orderId);
  }

  getOrder(id: number): OrderRow {
    return this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow;
  }

  /** Annote le comportement : achat après forte hausse, vente après forte baisse. */
  private recordBehavior(userId: number, symbol: string, side: "buy" | "sell", now: number): void {
    const hist = this.market.history(symbol, 10).map((c) => c.close);
    const perf5 = pctChange(hist, 5);
    const insert = this.db.prepare("INSERT INTO behavior_events(user_id, kind, symbol, payload, ts) VALUES (?,?,?,?,?)");
    insert.run(userId, "order", symbol, JSON.stringify({ side, perf5 }), now);
    if (side === "buy" && perf5 > 8) insert.run(userId, "order_chasing", symbol, JSON.stringify({ perf5 }), now);
    if (side === "sell" && perf5 < -6) insert.run(userId, "order_panic", symbol, JSON.stringify({ perf5 }), now);
  }

  cancelOrder(userId: number, orderId: number): void {
    const info = this.db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'open'").run(orderId, userId);
    if (info.changes === 0) throw new Error("Ordre introuvable ou non annulable");
  }

  /** Exécute les ordres ouverts devenus exécutables (appelé à chaque tick) et fait expirer les ordres « jour ». */
  matchOpenOrders(symbols: string[]): OrderRow[] {
    if (!symbols.length) return [];
    const now = Date.now();
    const dayStart = startOfDayUtc(now);
    this.db.prepare("UPDATE orders SET status = 'expired', note = 'Validité jour dépassée' WHERE status = 'open' AND validity = 'day' AND created_at < ?").run(dayStart);
    const placeholders = symbols.map(() => "?").join(",");
    const open = this.db.prepare(`SELECT * FROM orders WHERE status = 'open' AND symbol IN (${placeholders}) ORDER BY id`).all(...symbols) as OrderRow[];
    const filled: OrderRow[] = [];
    for (const o of open) {
      const current = this.getOrder(o.id);
      if (current.status !== "open") continue; // annulé par un OCO exécuté juste avant
      const mkt = this.market.price(o.symbol);
      if (o.type === "stop_limit" && !o.triggered_at && (o.side === "buy" ? mkt >= (o.stop_price ?? Infinity) : mkt <= (o.stop_price ?? 0))) {
        this.db.prepare("UPDATE orders SET triggered_at = ? WHERE id = ?").run(now, o.id);
        o.triggered_at = now;
      }
      const px = this.executablePrice({ type: o.type, side: o.side, limitPrice: o.limit_price, stopPrice: o.stop_price, triggered: !!o.triggered_at }, mkt);
      if (px === null) continue;
      try {
        filled.push(this.db.transaction(() => this.fill(o.id, px, now))());
      } catch (e) {
        this.db.prepare("UPDATE orders SET status = 'rejected', note = ? WHERE id = ?").run((e as Error).message, o.id);
      }
    }
    return filled;
  }

  // ---------- Instantanés et performance ----------

  /** Enregistre la valorisation du jour de chaque portefeuille (idempotent par jour). */
  snapshotAll(now = Date.now()): number {
    const day = startOfDayUtc(now);
    const rows = this.db.prepare("SELECT id, cash FROM portfolios").all() as { id: number; cash: number }[];
    const upsert = this.db.prepare("INSERT OR REPLACE INTO portfolio_snapshots(portfolio_id, day, total_value, cash, invested) VALUES (?,?,?,?,?)");
    const tx = this.db.transaction(() => {
      for (const p of rows) {
        const invested = this.positions(p.id).reduce((a, v) => a + v.marketValue, 0);
        upsert.run(p.id, day, p.cash + invested, p.cash, invested);
      }
    });
    tx();
    return rows.length;
  }

  performance(userId: number, days = 365) {
    const pf = this.getForUser(userId);
    const since = startOfDayUtc(Date.now()) - days * 86_400_000;
    const snaps = this.db
      .prepare("SELECT day, total_value AS totalValue, cash, invested FROM portfolio_snapshots WHERE portfolio_id = ? AND day >= ? ORDER BY day")
      .all(pf.id, since) as { day: number; totalValue: number; cash: number; invested: number }[];
    const summary = this.summary(userId);
    const today = startOfDayUtc(Date.now());
    if (!snaps.length || snaps[snaps.length - 1].day !== today) snaps.push({ day: today, totalValue: summary.totalValue, cash: pf.cash, invested: summary.invested });
    const idx = this.market.indexHistory(days + 5);
    const idxMap = new Map(idx.map((i) => [i.ts, i.composite]));
    let lastIdx = idx.find((i) => i.ts <= (snaps[0]?.day ?? today))?.composite ?? idx[0]?.composite ?? 100;
    const first = snaps[0]?.totalValue || pf.initialCash || 1;
    const firstIdx = idxMap.get(snaps[0]?.day) ?? lastIdx;
    const series = snaps.map((sn) => {
      if (idxMap.has(sn.day)) lastIdx = idxMap.get(sn.day)!;
      return { time: sn.day, value: sn.totalValue, portfolioPct: round2((sn.totalValue / first - 1) * 100), benchmarkPct: round2((lastIdx / firstIdx - 1) * 100) };
    });
    // statistiques
    const values = series.map((p) => p.value);
    const rets: number[] = [];
    for (let i = 1; i < values.length; i++) if (values[i - 1]) rets.push(values[i] / values[i - 1] - 1);
    const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
    let peak = -Infinity;
    let mdd = 0;
    for (const v of values) {
      peak = Math.max(peak, v);
      mdd = Math.min(mdd, v / peak - 1);
    }
    const trades = this.trades(userId);
    const sells = trades.filter((t) => t.side === "sell");
    const wins = sells.filter((t) => t.realizedPnl > 0);
    const losses = sells.filter((t) => t.realizedPnl <= 0);
    const avgWin = wins.length ? wins.reduce((a, t) => a + t.realizedPnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((a, t) => a + t.realizedPnl, 0) / losses.length : 0;
    return {
      series,
      stats: {
        totalReturnPct: round2(summary.totalPnlPct),
        benchmarkReturnPct: series.length ? series[series.length - 1].benchmarkPct : 0,
        volatilityPct: round2(sd * Math.sqrt(252) * 100),
        sharpe: sd ? round2(((mean - 0.05 / 252) / sd) * Math.sqrt(252)) : 0,
        maxDrawdownPct: round2(mdd * 100),
        trades: trades.length,
        winRate: sells.length ? Math.round((wins.length / sells.length) * 100) : 0,
        avgWin: Math.round(avgWin),
        avgLoss: Math.round(avgLoss),
        profitFactor: avgLoss ? round2(Math.abs((avgWin * wins.length) / (avgLoss * losses.length || 1))) : 0,
        realizedPnl: Math.round(summary.realizedPnl),
        unrealizedPnl: Math.round(summary.unrealizedPnl),
        feesPaid: Math.round(trades.reduce((a, t) => a + t.price * t.quantity * FEE_RATE, 0)),
      },
    };
  }

  /** Export CSV (séparateur point-virgule, compatible Excel FR) des transactions. */
  tradesCsv(userId: number): string {
    const rows = this.trades(userId, 10000);
    const head = "Date;Valeur;Sens;Quantité;Prix;Montant;Frais;Résultat réalisé";
    const lines = rows.map((t) => {
      const gross = t.price * t.quantity;
      return [new Date(t.ts).toISOString(), t.symbol, t.side === "buy" ? "Achat" : "Vente", t.quantity, t.price, Math.round(gross), Math.round(gross * FEE_RATE), Math.round(t.realizedPnl)].join(";");
    });
    return [head, ...lines].join("\n");
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
