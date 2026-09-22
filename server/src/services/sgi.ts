import { EventEmitter } from "node:events";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DB } from "../db/index.js";
import { INSTRUMENT_MAP } from "../data/instruments.js";
import { SGI_MAP, SGI_PARTNERS, type SgiPartner } from "../data/sgi.js";
import type { MarketService } from "./market.js";

export type SgiOrderStatus = "pending" | "transmitted" | "acknowledged" | "executed" | "partial" | "rejected" | "cancelled";
export type SgiAccountStatus = "pending" | "verified" | "rejected";

export interface SgiAccount {
  id: number;
  user_id: number;
  sgi_code: string;
  status: SgiAccountStatus;
  account_number: string | null;
  holder_name: string;
  id_type: string;
  id_number: string;
  phone: string;
  address: string;
  country: string;
  note: string | null;
  created_at: number;
  updated_at: number;
}

export interface SgiOrder {
  id: number;
  user_id: number;
  sgi_code: string;
  account_number: string | null;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: number;
  limit_price: number | null;
  validity: "day" | "week" | "gtc";
  status: SgiOrderStatus;
  executed_qty: number;
  executed_price: number | null;
  sgi_reference: string | null;
  estimated_amount: number;
  estimated_fees: number;
  note: string | null;
  created_at: number;
  updated_at: number;
}

export interface SgiOrderInput {
  sgiCode: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: number;
  limitPrice?: number;
  validity?: "day" | "week" | "gtc";
}

export interface AccountRequest {
  sgiCode: string;
  holderName: string;
  idType: string;
  idNumber: string;
  phone: string;
  address: string;
  country: string;
  accountNumber?: string;
}

/**
 * Connecteur vers le back-office d'une SGI. `console` : l'ordre est traité par le personnel
 * de la SGI dans la console intégrée. `webhook` : l'ordre est poussé en JSON signé (HMAC-SHA256)
 * vers l'URL du partenaire, qui renvoie ensuite les statuts via /api/sgi/webhook/:code.
 */
export interface SgiConnector {
  transmit(order: SgiOrder, partner: SgiPartner): Promise<{ transmitted: boolean; reference?: string; message?: string }>;
}

export class ConsoleConnector implements SgiConnector {
  async transmit(): Promise<{ transmitted: boolean; message: string }> {
    return { transmitted: true, message: "Ordre déposé dans la console de la SGI" };
  }
}

export class WebhookConnector implements SgiConnector {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async transmit(order: SgiOrder, partner: SgiPartner) {
    const body = JSON.stringify({ event: "order.new", partner: partner.code, order });
    const signature = createHmac("sha256", this.secret).update(body).digest("hex");
    const res = await this.fetchImpl(this.url, { method: "POST", headers: { "content-type": "application/json", "x-crackenmarket-signature": signature }, body });
    if (!res.ok) throw new Error(`Back-office ${partner.shortName} : HTTP ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as { reference?: string };
    return { transmitted: true, reference: data.reference, message: "Ordre transmis au back-office de la SGI" };
  }
}

const TRANSITIONS: Record<SgiOrderStatus, SgiOrderStatus[]> = {
  pending: ["transmitted", "cancelled", "rejected"],
  transmitted: ["acknowledged", "executed", "partial", "rejected", "cancelled"],
  acknowledged: ["executed", "partial", "rejected", "cancelled"],
  partial: ["executed", "partial", "cancelled"],
  executed: [],
  rejected: [],
  cancelled: [],
};

/**
 * Routage d'ordres réels vers les SGI partenaires : comptes-titres, transmission, suivi.
 * Émet `order_update` (pour notifier le client en temps réel) et `account_update`.
 */
export class SgiService extends EventEmitter {
  private connectors = new Map<string, SgiConnector>();

  constructor(
    private readonly db: DB,
    private readonly market: MarketService,
  ) {
    super();
    for (const p of SGI_PARTNERS) {
      const url = process.env[`SGI_${p.code}_WEBHOOK_URL`];
      const secret = process.env[`SGI_${p.code}_WEBHOOK_SECRET`];
      this.connectors.set(p.code, url && secret ? new WebhookConnector(url, secret) : new ConsoleConnector());
    }
  }

  partners(): (SgiPartner & { channelLabel: string })[] {
    return SGI_PARTNERS.map((p) => ({ ...p, channelLabel: this.connectors.get(p.code) instanceof WebhookConnector ? "Connexion directe au back-office" : "Console SGI intégrée" }));
  }

  // ---------- Comptes-titres ----------

  accounts(userId: number): SgiAccount[] {
    return this.db.prepare("SELECT * FROM sgi_accounts WHERE user_id = ? ORDER BY created_at DESC").all(userId) as SgiAccount[];
  }

  requestAccount(userId: number, input: AccountRequest): SgiAccount {
    const partner = SGI_MAP.get(input.sgiCode);
    if (!partner) throw new Error("SGI inconnue");
    const now = Date.now();
    // un client qui déclare déjà posséder un compte chez la SGI reste « pending » jusqu'à vérification par la SGI
    this.db
      .prepare(
        `INSERT INTO sgi_accounts(user_id, sgi_code, status, account_number, holder_name, id_type, id_number, phone, address, country, created_at, updated_at)
         VALUES (?,?,'pending',?,?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, sgi_code) DO UPDATE SET status = CASE WHEN sgi_accounts.status = 'verified' THEN 'verified' ELSE 'pending' END,
           account_number = COALESCE(excluded.account_number, sgi_accounts.account_number), holder_name = excluded.holder_name, id_type = excluded.id_type,
           id_number = excluded.id_number, phone = excluded.phone, address = excluded.address, country = excluded.country, updated_at = excluded.updated_at`,
      )
      .run(userId, input.sgiCode, input.accountNumber ?? null, input.holderName, input.idType, input.idNumber, input.phone, input.address, input.country, now, now);
    const acc = this.db.prepare("SELECT * FROM sgi_accounts WHERE user_id = ? AND sgi_code = ?").get(userId, input.sgiCode) as SgiAccount;
    this.emit("account_update", acc);
    return acc;
  }

  verifiedAccount(userId: number, sgiCode: string): SgiAccount | undefined {
    return this.db.prepare("SELECT * FROM sgi_accounts WHERE user_id = ? AND sgi_code = ? AND status = 'verified'").get(userId, sgiCode) as SgiAccount | undefined;
  }

  /** Côté SGI : valider (avec numéro de compte) ou refuser une demande d'ouverture. */
  reviewAccount(sgiCode: string, accountId: number, decision: "verified" | "rejected", accountNumber?: string, note?: string): SgiAccount {
    const acc = this.db.prepare("SELECT * FROM sgi_accounts WHERE id = ? AND sgi_code = ?").get(accountId, sgiCode) as SgiAccount | undefined;
    if (!acc) throw new Error("Demande introuvable");
    if (decision === "verified" && !accountNumber && !acc.account_number) throw new Error("Numéro de compte-titres requis pour valider");
    this.db
      .prepare("UPDATE sgi_accounts SET status = ?, account_number = COALESCE(?, account_number), note = ?, updated_at = ? WHERE id = ?")
      .run(decision, accountNumber ?? null, note ?? null, Date.now(), accountId);
    const updated = this.db.prepare("SELECT * FROM sgi_accounts WHERE id = ?").get(accountId) as SgiAccount;
    this.emit("account_update", updated);
    return updated;
  }

  // ---------- Ordres réels ----------

  estimateFees(partner: SgiPartner, amount: number): number {
    return Math.max(partner.minFee, amount * (partner.brokerageFeePct / 100)) + amount * (partner.marketFeePct / 100);
  }

  async placeOrder(userId: number, input: SgiOrderInput): Promise<SgiOrder> {
    const partner = SGI_MAP.get(input.sgiCode);
    if (!partner) throw new Error("SGI inconnue");
    const inst = INSTRUMENT_MAP.get(input.symbol);
    if (!inst) throw new Error("Valeur inconnue");
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error("Quantité invalide");
    if (input.type === "limit" && !(input.limitPrice && input.limitPrice > 0)) throw new Error("Prix limite requis");
    const account = this.verifiedAccount(userId, input.sgiCode);
    if (!account) throw new Error(`Votre compte-titres chez ${partner.shortName} n'est pas encore validé`);
    const px = input.type === "limit" ? input.limitPrice! : (this.market.price(input.symbol) || inst.refPrice);
    const amount = px * input.quantity;
    const fees = this.estimateFees(partner, amount);
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO sgi_orders(user_id, sgi_code, account_number, symbol, side, type, quantity, limit_price, validity, status, estimated_amount, estimated_fees, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
      )
      .run(userId, input.sgiCode, account.account_number, input.symbol, input.side, input.type, input.quantity, input.limitPrice ?? null, input.validity ?? "day", amount, fees, now, now);
    const id = Number(info.lastInsertRowid);
    this.logEvent(id, "pending", "client", "Ordre saisi par le client");
    let order = this.getOrder(id);
    try {
      const r = await this.connectors.get(partner.code)!.transmit(order, partner);
      if (r.transmitted) order = this.transition(id, "transmitted", "system", r.message ?? null, r.reference);
    } catch (e) {
      order = this.transition(id, "rejected", "system", `Transmission impossible : ${(e as Error).message}`);
    }
    return order;
  }

  getOrder(id: number): SgiOrder {
    return this.db.prepare("SELECT * FROM sgi_orders WHERE id = ?").get(id) as SgiOrder;
  }

  orders(userId: number, limit = 100): SgiOrder[] {
    return this.db.prepare("SELECT * FROM sgi_orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(userId, limit) as SgiOrder[];
  }

  events(orderId: number) {
    return this.db.prepare("SELECT status, actor, message, ts FROM sgi_order_events WHERE order_id = ? ORDER BY ts, id").all(orderId) as { status: string; actor: string; message: string | null; ts: number }[];
  }

  cancelByClient(userId: number, orderId: number): SgiOrder {
    const o = this.db.prepare("SELECT * FROM sgi_orders WHERE id = ? AND user_id = ?").get(orderId, userId) as SgiOrder | undefined;
    if (!o) throw new Error("Ordre introuvable");
    if (!TRANSITIONS[o.status].includes("cancelled")) throw new Error("Cet ordre ne peut plus être annulé");
    return this.transition(orderId, "cancelled", "client", "Annulation demandée par le client");
  }

  /** Console SGI : file des ordres et demandes de compte de l'établissement. */
  queue(sgiCode: string) {
    const orders = this.db
      .prepare(
        `SELECT o.*, u.full_name AS client_name, u.email AS client_email FROM sgi_orders o JOIN users u ON u.id = o.user_id
         WHERE o.sgi_code = ? ORDER BY CASE o.status WHEN 'transmitted' THEN 0 WHEN 'acknowledged' THEN 1 WHEN 'partial' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END, o.created_at DESC LIMIT 300`,
      )
      .all(sgiCode) as (SgiOrder & { client_name: string; client_email: string })[];
    const accounts = this.db
      .prepare(`SELECT a.*, u.email AS client_email FROM sgi_accounts a JOIN users u ON u.id = a.user_id WHERE a.sgi_code = ? ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 300`)
      .all(sgiCode) as (SgiAccount & { client_email: string })[];
    const stats = this.db
      .prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(estimated_amount),0) AS amount FROM sgi_orders WHERE sgi_code = ? GROUP BY status`)
      .all(sgiCode) as { status: SgiOrderStatus; n: number; amount: number }[];
    return { orders, accounts, stats };
  }

  /** Console SGI ou webhook du partenaire : mise à jour du statut d'un ordre. */
  updateBySgi(sgiCode: string, orderId: number, status: SgiOrderStatus, opts: { executedQty?: number; executedPrice?: number; reference?: string; message?: string } = {}): SgiOrder {
    const o = this.db.prepare("SELECT * FROM sgi_orders WHERE id = ? AND sgi_code = ?").get(orderId, sgiCode) as SgiOrder | undefined;
    if (!o) throw new Error("Ordre introuvable pour cette SGI");
    if (!TRANSITIONS[o.status].includes(status)) throw new Error(`Transition ${o.status} → ${status} impossible`);
    if (status === "executed" || status === "partial") {
      const qty = opts.executedQty ?? o.quantity;
      if (!Number.isInteger(qty) || qty <= 0 || qty > o.quantity) throw new Error("Quantité exécutée invalide");
      if (!(opts.executedPrice && opts.executedPrice > 0)) throw new Error("Prix d'exécution requis");
      if (status === "executed" && qty < o.quantity) throw new Error("Exécution totale : la quantité doit être égale à la quantité de l'ordre");
      this.db.prepare("UPDATE sgi_orders SET executed_qty = ?, executed_price = ? WHERE id = ?").run(qty, opts.executedPrice, orderId);
    }
    return this.transition(orderId, status, "sgi", opts.message ?? null, opts.reference);
  }

  private transition(orderId: number, status: SgiOrderStatus, actor: "client" | "sgi" | "system", message: string | null, reference?: string): SgiOrder {
    this.db.prepare("UPDATE sgi_orders SET status = ?, sgi_reference = COALESCE(?, sgi_reference), updated_at = ? WHERE id = ?").run(status, reference ?? null, Date.now(), orderId);
    this.logEvent(orderId, status, actor, message);
    const order = this.getOrder(orderId);
    this.emit("order_update", order);
    return order;
  }

  private logEvent(orderId: number, status: string, actor: string, message: string | null): void {
    this.db.prepare("INSERT INTO sgi_order_events(order_id, status, actor, message, ts) VALUES (?,?,?,?,?)").run(orderId, status, actor, message, Date.now());
  }

  /** Vérifie la signature HMAC d'un webhook entrant du partenaire. */
  verifyWebhook(sgiCode: string, rawBody: string, signature: string | undefined): boolean {
    const secret = process.env[`SGI_${sgiCode}_WEBHOOK_SECRET`];
    if (!secret || !signature) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  /** Rattache un utilisateur de rôle « sgi » à son établissement (admin). */
  assignStaff(userId: number, sgiCode: string): void {
    if (!SGI_MAP.has(sgiCode)) throw new Error("SGI inconnue");
    this.db.prepare("UPDATE users SET role = 'sgi', sgi_code = ? WHERE id = ?").run(sgiCode, userId);
  }

  staffSgiCode(userId: number): string | null {
    const row = this.db.prepare("SELECT role, sgi_code FROM users WHERE id = ?").get(userId) as { role: string; sgi_code: string | null } | undefined;
    if (!row) return null;
    if (row.role === "admin") return row.sgi_code ?? SGI_PARTNERS[0]?.code ?? null;
    return row.role === "sgi" ? row.sgi_code : null;
  }
}
