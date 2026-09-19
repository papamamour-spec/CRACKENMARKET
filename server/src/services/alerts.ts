import type { DB } from "../db/index.js";
import type { QuoteSnapshot } from "./market.js";

export interface AlertRow {
  id: number;
  user_id: number;
  symbol: string;
  condition: "above" | "below" | "pct_move";
  value: number;
  active: number;
  triggered_at: number | null;
  created_at: number;
}

export interface TriggeredAlert {
  alert: AlertRow;
  price: number;
  message: string;
}

export class AlertService {
  constructor(private readonly db: DB) {}

  list(userId: number): AlertRow[] {
    return this.db.prepare("SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at DESC").all(userId) as AlertRow[];
  }

  create(userId: number, symbol: string, condition: AlertRow["condition"], value: number): AlertRow {
    const info = this.db
      .prepare("INSERT INTO alerts(user_id, symbol, condition, value, active, created_at) VALUES (?,?,?,?,1,?)")
      .run(userId, symbol, condition, value, Date.now());
    return this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(Number(info.lastInsertRowid)) as AlertRow;
  }

  remove(userId: number, id: number): void {
    this.db.prepare("DELETE FROM alerts WHERE id = ? AND user_id = ?").run(id, userId);
  }

  /** Évalue les alertes actives sur les cotations reçues. */
  evaluate(quotes: QuoteSnapshot[]): TriggeredAlert[] {
    const out: TriggeredAlert[] = [];
    const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
    const symbols = [...bySymbol.keys()];
    if (!symbols.length) return out;
    const rows = this.db
      .prepare(`SELECT * FROM alerts WHERE active = 1 AND symbol IN (${symbols.map(() => "?").join(",")})`)
      .all(...symbols) as AlertRow[];
    const trigger = this.db.prepare("UPDATE alerts SET active = 0, triggered_at = ? WHERE id = ?");
    for (const a of rows) {
      const q = bySymbol.get(a.symbol)!;
      let hit = false;
      let message = "";
      if (a.condition === "above" && q.price >= a.value) {
        hit = true;
        message = `${a.symbol} a franchi ${a.value.toLocaleString("fr-FR")} FCFA à la hausse (${q.price.toLocaleString("fr-FR")})`;
      } else if (a.condition === "below" && q.price <= a.value) {
        hit = true;
        message = `${a.symbol} est passé sous ${a.value.toLocaleString("fr-FR")} FCFA (${q.price.toLocaleString("fr-FR")})`;
      } else if (a.condition === "pct_move" && Math.abs(q.changePct) >= a.value) {
        hit = true;
        message = `${a.symbol} varie de ${q.changePct.toFixed(2)} % en séance`;
      }
      if (hit) {
        const now = Date.now();
        trigger.run(now, a.id);
        out.push({ alert: { ...a, active: 0, triggered_at: now }, price: q.price, message });
      }
    }
    return out;
  }
}
