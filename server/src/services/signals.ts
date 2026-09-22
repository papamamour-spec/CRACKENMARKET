import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { INSTRUMENTS } from "../data/instruments.js";
import type { AdvisorService } from "./advisor.js";
import type { MarketService } from "./market.js";

export interface Signal {
  id: number;
  symbol: string;
  kind: "bullish" | "bearish" | "neutral";
  message: string;
  price: number;
  ts: number;
}

const BULLISH = /doré|survente|sous la bande|au-dessus de sa ligne|support|forte hausse/i;
const BEARISH = /mort|surachat|au-dessus de la bande|en dessous de sa ligne|résistance/i;

/**
 * Flux de signaux Kraken : détecte les nouveaux signaux techniques et les mouvements de séance
 * remarquables, les persiste et les diffuse en temps réel. Un même signal n'est pas répété
 * pour une valeur pendant 24 h.
 */
export class SignalService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DB,
    private readonly market: MarketService,
    private readonly advisor: AdvisorService,
  ) {
    super();
  }

  start(intervalMs = 5 * 60_000): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), intervalMs);
    // mouvements de séance : évalués à chaque tick
    this.market.on("quotes", (qs: { symbol: string; changePct: number; price: number }[]) => {
      for (const q of qs) {
        if (Math.abs(q.changePct) >= 5) {
          this.publish(q.symbol, q.changePct > 0 ? "bullish" : "bearish", `${q.symbol} ${q.changePct > 0 ? "bondit" : "chute"} de ${q.changePct.toFixed(1)} % en séance`, q.price);
        }
      }
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  scan(): void {
    for (const inst of INSTRUMENTS) {
      const t = this.advisor.technical(inst.symbol);
      for (const msg of t.signals) {
        const kind = BULLISH.test(msg) ? "bullish" : BEARISH.test(msg) ? "bearish" : "neutral";
        this.publish(inst.symbol, kind, msg, t.price);
      }
    }
  }

  private publish(symbol: string, kind: Signal["kind"], message: string, price: number): void {
    const dayAgo = Date.now() - 86_400_000;
    const dup = this.db.prepare("SELECT 1 FROM signals WHERE symbol = ? AND message = ? AND ts > ?").get(symbol, message, dayAgo);
    if (dup) return;
    const ts = Date.now();
    const info = this.db.prepare("INSERT INTO signals(symbol, kind, message, price, ts) VALUES (?,?,?,?,?)").run(symbol, kind, message, price, ts);
    const signal: Signal = { id: Number(info.lastInsertRowid), symbol, kind, message, price, ts };
    this.emit("signal", signal);
  }

  latest(limit = 100, symbol?: string): Signal[] {
    if (symbol) return this.db.prepare("SELECT * FROM signals WHERE symbol = ? ORDER BY ts DESC LIMIT ?").all(symbol, limit) as Signal[];
    return this.db.prepare("SELECT * FROM signals ORDER BY ts DESC LIMIT ?").all(limit) as Signal[];
  }
}
