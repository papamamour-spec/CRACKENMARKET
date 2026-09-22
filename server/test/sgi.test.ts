import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { openMemoryDb, type DB } from "../src/db/index.js";
import { AuthService } from "../src/services/auth.js";
import { SgiService } from "../src/services/sgi.js";
import type { MarketService } from "../src/services/market.js";

const market = { price: () => 22000 } as unknown as MarketService;
const request = { sgiCode: "MATHA", holderName: "Aminata Diallo", idType: "cni", idNumber: "SN123456", phone: "+221770000000", address: "Dakar Plateau", country: "SN" };

describe("routage d'ordres vers la SGI", () => {
  let db: DB;
  let sgi: SgiService;
  let userId: number;

  beforeEach(() => {
    db = openMemoryDb();
    sgi = new SgiService(db, market);
    userId = new AuthService(db).register("a@ex.com", "secret123", "Aminata Diallo").id;
  });

  it("refuse un ordre réel tant que le compte-titres n'est pas validé", async () => {
    sgi.requestAccount(userId, request);
    await expect(sgi.placeOrder(userId, { sgiCode: "MATHA", symbol: "SNTS", side: "buy", type: "market", quantity: 10 })).rejects.toThrow(/pas encore validé/);
  });

  it("transmet l'ordre après validation, puis suit l'exécution par la SGI", async () => {
    const acc = sgi.requestAccount(userId, request);
    expect(acc.status).toBe("pending");
    const verified = sgi.reviewAccount("MATHA", acc.id, "verified", "MC-000123");
    expect(verified.status).toBe("verified");
    const events: string[] = [];
    sgi.on("order_update", (o) => events.push(o.status));
    const o = await sgi.placeOrder(userId, { sgiCode: "MATHA", symbol: "SNTS", side: "buy", type: "limit", quantity: 10, limitPrice: 21500 });
    expect(o.status).toBe("transmitted");
    expect(o.account_number).toBe("MC-000123");
    expect(o.estimated_amount).toBe(215000);
    expect(o.estimated_fees).toBeGreaterThan(0);
    sgi.updateBySgi("MATHA", o.id, "acknowledged", { reference: "MATHA-42" });
    const done = sgi.updateBySgi("MATHA", o.id, "executed", { executedQty: 10, executedPrice: 21450 });
    expect(done.status).toBe("executed");
    expect(done.sgi_reference).toBe("MATHA-42");
    expect(events).toEqual(["transmitted", "acknowledged", "executed"]);
    expect(sgi.events(o.id).map((e) => e.status)).toEqual(["pending", "transmitted", "acknowledged", "executed"]);
    expect(() => sgi.updateBySgi("MATHA", o.id, "rejected")).toThrow(/impossible/);
  });

  it("le client peut annuler un ordre non exécuté, pas un ordre exécuté", async () => {
    const acc = sgi.requestAccount(userId, request);
    sgi.reviewAccount("MATHA", acc.id, "verified", "MC-1");
    const o = await sgi.placeOrder(userId, { sgiCode: "MATHA", symbol: "SNTS", side: "sell", type: "market", quantity: 5 });
    expect(sgi.cancelByClient(userId, o.id).status).toBe("cancelled");
    expect(() => sgi.cancelByClient(userId, o.id)).toThrow();
  });

  it("la console de la SGI voit ses ordres et ses demandes de compte", async () => {
    const acc = sgi.requestAccount(userId, request);
    sgi.reviewAccount("MATHA", acc.id, "verified", "MC-1");
    await sgi.placeOrder(userId, { sgiCode: "MATHA", symbol: "ORAC", side: "buy", type: "market", quantity: 3 });
    const q = sgi.queue("MATHA");
    expect(q.orders).toHaveLength(1);
    expect(q.orders[0].client_name).toBe("Aminata Diallo");
    expect(q.accounts[0].status).toBe("verified");
  });

  it("vérifie la signature HMAC des webhooks entrants", () => {
    process.env.SGI_MATHA_WEBHOOK_SECRET = "s3cret";
    const body = JSON.stringify({ orderId: 1, status: "executed" });
    const sig = createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(sgi.verifyWebhook("MATHA", body, sig)).toBe(true);
    expect(sgi.verifyWebhook("MATHA", body, sig.replace(/./, "0"))).toBe(false);
    delete process.env.SGI_MATHA_WEBHOOK_SECRET;
  });
});
