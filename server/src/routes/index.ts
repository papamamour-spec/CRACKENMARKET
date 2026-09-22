import { Router } from "express";
import { z } from "zod";
import { INSTRUMENTS, INSTRUMENT_MAP, SECTORS } from "../data/instruments.js";
import { backtest } from "../engine/backtest.js";
import { config } from "../config.js";
import { indicatorSeries } from "../engine/technical.js";
import { POINTS, ROLES, type AuthService, type Role } from "../services/auth.js";
import type { SocialService } from "../services/social.js";
import type { SignalService } from "../services/signals.js";
import { buildEventCalendar } from "../data/events.js";
import type { SgiService, SgiOrderStatus } from "../services/sgi.js";
import type { AdvisorService } from "../services/advisor.js";
import type { AlertService } from "../services/alerts.js";
import type { MarketService } from "../services/market.js";
import type { PortfolioService } from "../services/portfolio.js";
import { asyncHandler, requireAuth } from "./middleware.js";
import type { DB } from "../db/index.js";

export interface Services {
  db: DB;
  auth: AuthService;
  market: MarketService;
  portfolios: PortfolioService;
  advisor: AdvisorService;
  alerts: AlertService;
  social: SocialService;
  signals: SignalService;
  sgi: SgiService;
}

export function buildRouter(s: Services): Router {
  const r = Router();
  const guard = requireAuth(s.auth);

  // ---------- Santé ----------
  r.get("/health", (_req, res) => res.json({ ok: true, ...s.market.status() }));

  // ---------- Auth ----------
  const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    fullName: z.string().min(2),
    role: z.enum(ROLES as [Role, ...Role[]]).optional(),
    referralCode: z.string().max(20).optional(),
  });
  r.post(
    "/auth/register",
    asyncHandler((req, res) => {
      const body = registerSchema.parse(req.body);
      const role = body.role === "admin" ? "investor" : (body.role ?? "investor");
      const user = s.auth.register(body.email, body.password, body.fullName, role, body.referralCode || undefined);
      res.status(201).json({ user, token: s.auth.sign(user) });
    }),
  );
  r.post(
    "/auth/login",
    asyncHandler((req, res) => {
      const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
      const user = s.auth.login(body.email, body.password);
      if (user.totpEnabled) return res.json({ requires2fa: true, tempToken: s.auth.sign(user, { pre2fa: true }) });
      res.json({ user, token: s.auth.sign(user) });
    }),
  );
  r.post(
    "/auth/2fa/verify",
    asyncHandler((req, res) => {
      const body = z.object({ tempToken: z.string(), code: z.string() }).parse(req.body);
      const payload = s.auth.verify(body.tempToken);
      if (!payload.pre2fa) throw new Error("Jeton invalide");
      if (!s.auth.verifyTotpFor(payload.sub, body.code)) throw new Error("Code invalide");
      const user = s.auth.getUser(payload.sub)!;
      res.json({ user, token: s.auth.sign(user) });
    }),
  );
  r.post("/auth/2fa/setup", guard, asyncHandler((req, res) => res.json(s.auth.setupTotp(req.auth!.sub))));
  r.post(
    "/auth/2fa/enable",
    guard,
    asyncHandler((req, res) => {
      const body = z.object({ code: z.string() }).parse(req.body);
      s.auth.enableTotp(req.auth!.sub, body.code);
      res.json({ ok: true, user: s.auth.getUser(req.auth!.sub) });
    }),
  );
  r.post(
    "/auth/2fa/disable",
    guard,
    asyncHandler((req, res) => {
      const body = z.object({ code: z.string() }).parse(req.body);
      s.auth.disableTotp(req.auth!.sub, body.code);
      res.json({ ok: true, user: s.auth.getUser(req.auth!.sub) });
    }),
  );

  // ---------- Compte : parrainage, visibilité, clés API ----------
  r.get("/account/referrals", guard, (req, res) => res.json({ user: s.auth.getUser(req.auth!.sub), ...s.auth.referrals(req.auth!.sub), rewards: POINTS }));
  r.put(
    "/account/public",
    guard,
    asyncHandler((req, res) => {
      const body = z.object({ publicProfile: z.boolean() }).parse(req.body);
      s.auth.setPublicProfile(req.auth!.sub, body.publicProfile);
      res.json({ ok: true, user: s.auth.getUser(req.auth!.sub) });
    }),
  );
  r.get("/account/apikeys", guard, (req, res) => res.json(s.auth.listApiKeys(req.auth!.sub)));
  r.post(
    "/account/apikeys",
    guard,
    asyncHandler((req, res) => {
      const body = z.object({ label: z.string().min(1).max(60) }).parse(req.body);
      if (s.auth.listApiKeys(req.auth!.sub).length >= 5) throw new Error("5 clés maximum par compte");
      res.status(201).json(s.auth.createApiKey(req.auth!.sub, body.label));
    }),
  );
  r.delete("/account/apikeys/:id", guard, (req, res) => {
    s.auth.revokeApiKey(req.auth!.sub, Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------- Social : classement, profils publics, suivi ----------
  const optionalViewer = (req: { headers: Record<string, unknown> }): number | null => {
    const header = String(req.headers.authorization ?? "");
    if (!header.startsWith("Bearer ")) return null;
    try {
      return s.auth.verify(header.slice(7)).sub;
    } catch {
      return null;
    }
  };
  r.get("/social/leaderboard", (req, res) => {
    const period = req.query.period === "month" ? "month" : "all";
    res.json(s.social.leaderboard(optionalViewer(req), period));
  });
  r.get("/social/profile/:id", asyncHandler((req, res) => res.json(s.social.publicProfile(Number(req.params.id), optionalViewer(req)))));
  r.post(
    "/social/follow/:id",
    guard,
    asyncHandler((req, res) => {
      s.social.follow(req.auth!.sub, Number(req.params.id));
      res.status(201).json({ ok: true });
    }),
  );
  r.delete("/social/follow/:id", guard, (req, res) => {
    s.social.unfollow(req.auth!.sub, Number(req.params.id));
    res.json({ ok: true });
  });
  r.get("/social/activity", guard, (req, res) => res.json(s.social.followedActivity(req.auth!.sub)));
  r.get("/auth/me", guard, (req, res) => {
    const user = s.auth.getUser(req.auth!.sub);
    if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });
    res.json({ user, profile: s.advisor.declaredProfile(user.id) });
  });

  // ---------- Marché (public) ----------
  r.get("/market/status", (_req, res) => res.json(s.market.status()));
  r.get("/market/indices", (_req, res) => res.json(s.market.indices()));
  r.get("/market/sectors", (_req, res) => res.json({ sectors: SECTORS, summary: s.market.sectorSummary() }));
  r.get("/market/instruments", (_req, res) => res.json(INSTRUMENTS));
  r.get("/market/quotes", (_req, res) => res.json(s.market.allSnapshots()));
  r.get("/market/quotes/:symbol", (req, res) => {
    const snap = s.market.snapshot(req.params.symbol.toUpperCase());
    if (!snap) return res.status(404).json({ error: "Valeur inconnue" });
    res.json({ ...snap, instrument: INSTRUMENT_MAP.get(snap.symbol) });
  });
  r.get("/market/history/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return res.status(404).json({ error: "Valeur inconnue" });
    const tf = (String(req.query.timeframe ?? "1D") as "1D" | "1W" | "1M" | "1m");
    const limit = Math.min(2000, Number(req.query.limit ?? 500));
    const candles = s.market.historyAggregated(symbol, tf, limit);
    res.json({ symbol, timeframe: tf, candles, indicators: tf === "1m" ? null : indicatorSeries(candles) });
  });
  r.get("/market/ticks/:symbol", (req, res) => res.json(s.market.recentTicks(req.params.symbol.toUpperCase(), Number(req.query.limit ?? 50))));
  r.get("/market/screener", (_req, res) => res.json(s.advisor.marketScreener()));
  r.get("/market/technical/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return res.status(404).json({ error: "Valeur inconnue" });
    res.json(s.advisor.technical(symbol));
  });
  r.get("/market/book/:symbol", (req, res) => {
    const book = s.market.orderBook(req.params.symbol.toUpperCase());
    if (!book) return res.status(404).json({ error: "Valeur inconnue" });
    res.json(book);
  });
  r.get("/market/signals", (req, res) => {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
    res.json(s.signals.latest(Math.min(300, Number(req.query.limit ?? 100)), symbol));
  });
  r.get("/market/events", (req, res) => {
    const now = Date.now();
    const from = Number(req.query.from ?? now - 30 * 86_400_000);
    const to = Number(req.query.to ?? now + 120 * 86_400_000);
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    const year = new Date(now).getUTCFullYear();
    const all = [...buildEventCalendar(year), ...buildEventCalendar(year + 1)];
    res.json(all.filter((e) => e.date >= from && e.date <= to && (!symbol || e.symbol === symbol || e.symbol === null)));
  });
  r.get("/market/index-history", (req, res) => res.json(s.market.indexHistory(Math.min(2000, Number(req.query.days ?? 400)))));
  r.get("/market/movers", (_req, res) => {
    const all = s.market.allSnapshots();
    const byChange = [...all].sort((a, b) => b.changePct - a.changePct);
    const byValue = [...all].sort((a, b) => b.value - a.value);
    res.json({ gainers: byChange.slice(0, 5), losers: byChange.slice(-5).reverse(), mostActive: byValue.slice(0, 5) });
  });

  // ---------- Backtest ----------
  r.get("/backtest/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return res.status(404).json({ error: "Valeur inconnue" });
    const strategy = z.enum(["sma_cross", "rsi_reversion", "macd", "buy_hold"]).parse(req.query.strategy ?? "sma_cross");
    const capital = Number(req.query.capital ?? 1_000_000);
    res.json(backtest(symbol, s.market.history(symbol, config.historyDays), strategy, capital));
  });

  // ---------- Profil investisseur ----------
  const profileSchema = z.object({
    riskTolerance: z.number().int().min(1).max(5),
    horizonMonths: z.number().int().min(1).max(360),
    objective: z.enum(["income", "growth", "balanced", "speculative"]),
    experience: z.enum(["beginner", "intermediate", "expert"]),
    monthlyCapacity: z.number().min(0),
    preferredSectors: z.array(z.string()).max(10),
  });
  r.get("/profile", guard, (req, res) => res.json(s.advisor.declaredProfile(req.auth!.sub)));
  r.put(
    "/profile",
    guard,
    asyncHandler((req, res) => {
      const p = profileSchema.parse(req.body);
      s.advisor.saveDeclaredProfile(req.auth!.sub, p);
      res.json(p);
    }),
  );
  r.get("/profile/behavior", guard, (req, res) => res.json(s.advisor.behaviorProfile(req.auth!.sub)));

  // ---------- Conseiller ----------
  r.get("/advisor/recommendations", guard, (req, res) => res.json(s.advisor.recommendations(req.auth!.sub)));
  r.get("/advisor/recommendations/:symbol", guard, (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return res.status(404).json({ error: "Valeur inconnue" });
    s.advisor.recordView(req.auth!.sub, symbol);
    res.json(s.advisor.recommendationFor(req.auth!.sub, symbol));
  });
  r.get("/advisor/portfolio", guard, (req, res) => res.json(s.advisor.portfolioDiagnostic(req.auth!.sub)));
  r.post(
    "/advisor/feedback",
    guard,
    asyncHandler((req, res) => {
      const body = z.object({ symbol: z.string(), followed: z.boolean() }).parse(req.body);
      s.advisor.recordAdviceFeedback(req.auth!.sub, body.symbol.toUpperCase(), body.followed);
      res.json({ ok: true });
    }),
  );

  // ---------- Portefeuille & ordres ----------
  r.get("/portfolio", guard, (req, res) => res.json(s.portfolios.summary(req.auth!.sub)));
  r.get("/portfolio/orders", guard, (req, res) => res.json(s.portfolios.orders(req.auth!.sub)));
  r.get("/portfolio/trades", guard, (req, res) => res.json(s.portfolios.trades(req.auth!.sub)));
  r.get("/portfolio/trades.csv", guard, (req, res) => {
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", 'attachment; filename="crackenmarket-operations.csv"');
    res.send("\ufeff" + s.portfolios.tradesCsv(req.auth!.sub));
  });
  r.get("/portfolio/performance", guard, (req, res) => res.json(s.portfolios.performance(req.auth!.sub, Math.min(2000, Number(req.query.days ?? 365)))));
  const orderSchema = z.object({
    symbol: z.string().min(2).max(6),
    side: z.enum(["buy", "sell"]),
    type: z.enum(["market", "limit", "stop", "stop_limit"]).default("market"),
    quantity: z.number().int().positive(),
    limitPrice: z.number().positive().optional(),
    stopPrice: z.number().positive().optional(),
    validity: z.enum(["day", "gtc"]).optional(),
    takeProfit: z.number().positive().optional(),
    stopLoss: z.number().positive().optional(),
    note: z.string().max(200).optional(),
  });
  r.post(
    "/portfolio/orders",
    guard,
    asyncHandler((req, res) => {
      const body = orderSchema.parse(req.body);
      const order = s.portfolios.placeOrder(req.auth!.sub, { ...body, symbol: body.symbol.toUpperCase() });
      if (order.status === "filled") s.auth.addPointsOnce(req.auth!.sub, POINTS.firstOrder, "Premier ordre exécuté");
      res.status(201).json({ order, summary: s.portfolios.summary(req.auth!.sub) });
    }),
  );
  r.delete(
    "/portfolio/orders/:id",
    guard,
    asyncHandler((req, res) => {
      s.portfolios.cancelOrder(req.auth!.sub, Number(req.params.id));
      res.json({ ok: true });
    }),
  );

  // ---------- SGI partenaires : compte-titres et ordres réels ----------
  r.get("/sgi/partners", (_req, res) => res.json(s.sgi.partners()));
  r.get("/sgi/accounts", guard, (req, res) => res.json(s.sgi.accounts(req.auth!.sub)));
  const accountSchema = z.object({
    sgiCode: z.string(),
    holderName: z.string().min(3).max(120),
    idType: z.enum(["cni", "passeport", "carte_consulaire", "rccm"]),
    idNumber: z.string().min(3).max(40),
    phone: z.string().min(6).max(30),
    address: z.string().min(5).max(200),
    country: z.string().length(2),
    accountNumber: z.string().max(40).optional(),
  });
  r.post(
    "/sgi/accounts",
    guard,
    asyncHandler((req, res) => res.status(201).json(s.sgi.requestAccount(req.auth!.sub, accountSchema.parse(req.body)))),
  );
  const sgiOrderSchema = z.object({
    sgiCode: z.string(),
    symbol: z.string().min(2).max(6),
    side: z.enum(["buy", "sell"]),
    type: z.enum(["market", "limit"]),
    quantity: z.number().int().positive(),
    limitPrice: z.number().positive().optional(),
    validity: z.enum(["day", "week", "gtc"]).optional(),
  });
  r.get("/sgi/orders", guard, (req, res) => res.json(s.sgi.orders(req.auth!.sub)));
  r.post(
    "/sgi/orders",
    guard,
    asyncHandler(async (req, res) => {
      const body = sgiOrderSchema.parse(req.body);
      res.status(201).json(await s.sgi.placeOrder(req.auth!.sub, { ...body, symbol: body.symbol.toUpperCase() }));
    }),
  );
  r.get(
    "/sgi/orders/:id/events",
    guard,
    asyncHandler((req, res) => {
      const o = s.sgi.getOrder(Number(req.params.id));
      const staff = s.sgi.staffSgiCode(req.auth!.sub);
      if (!o || (o.user_id !== req.auth!.sub && staff !== o.sgi_code)) throw new Error("Ordre introuvable");
      res.json(s.sgi.events(o.id));
    }),
  );
  r.delete("/sgi/orders/:id", guard, asyncHandler((req, res) => res.json(s.sgi.cancelByClient(req.auth!.sub, Number(req.params.id)))));

  // Console SGI (rôle sgi rattaché à un établissement, ou admin)
  const sgiStaff = (req: { auth?: { sub: number } }): string => {
    const code = s.sgi.staffSgiCode(req.auth!.sub);
    if (!code) throw Object.assign(new Error("Réservé au personnel d'une SGI partenaire"), { status: 403 });
    return code;
  };
  r.get("/sgi/console", guard, asyncHandler((req, res) => res.json({ sgiCode: sgiStaff(req), ...s.sgi.queue(sgiStaff(req)) })));
  r.post(
    "/sgi/console/orders/:id",
    guard,
    asyncHandler((req, res) => {
      const body = z
        .object({
          status: z.enum(["acknowledged", "executed", "partial", "rejected", "cancelled"]),
          executedQty: z.number().int().positive().optional(),
          executedPrice: z.number().positive().optional(),
          reference: z.string().max(60).optional(),
          message: z.string().max(300).optional(),
        })
        .parse(req.body);
      res.json(s.sgi.updateBySgi(sgiStaff(req), Number(req.params.id), body.status as SgiOrderStatus, body));
    }),
  );
  r.post(
    "/sgi/console/accounts/:id",
    guard,
    asyncHandler((req, res) => {
      const body = z.object({ decision: z.enum(["verified", "rejected"]), accountNumber: z.string().max(40).optional(), note: z.string().max(300).optional() }).parse(req.body);
      res.json(s.sgi.reviewAccount(sgiStaff(req), Number(req.params.id), body.decision, body.accountNumber, body.note));
    }),
  );
  // Rattachement d'un collaborateur SGI (administrateur uniquement)
  r.post(
    "/sgi/staff",
    guard,
    asyncHandler((req, res) => {
      if (req.auth!.role !== "admin") throw Object.assign(new Error("Réservé à l'administrateur"), { status: 403 });
      const body = z.object({ email: z.string().email(), sgiCode: z.string() }).parse(req.body);
      const user = s.db.prepare("SELECT id FROM users WHERE email = ?").get(body.email.toLowerCase()) as { id: number } | undefined;
      if (!user) throw new Error("Utilisateur introuvable");
      s.sgi.assignStaff(user.id, body.sgiCode);
      res.json({ ok: true });
    }),
  );
  // Webhook entrant du back-office partenaire : statuts d'exécution (signature HMAC-SHA256 du corps brut)
  r.post(
    "/sgi/webhook/:code",
    asyncHandler((req, res) => {
      const code = req.params.code.toUpperCase();
      const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
      if (!s.sgi.verifyWebhook(code, raw, req.headers["x-crackenmarket-signature"] as string | undefined)) {
        return res.status(401).json({ error: "Signature invalide" });
      }
      const body = z
        .object({
          orderId: z.number().int(),
          status: z.enum(["acknowledged", "executed", "partial", "rejected", "cancelled"]),
          executedQty: z.number().int().positive().optional(),
          executedPrice: z.number().positive().optional(),
          reference: z.string().max(60).optional(),
          message: z.string().max(300).optional(),
        })
        .parse(req.body);
      res.json(s.sgi.updateBySgi(code, body.orderId, body.status as SgiOrderStatus, body));
    }),
  );

  // ---------- Liste de suivi ----------
  r.get("/watchlist", guard, (req, res) => {
    const rows = s.db.prepare("SELECT symbol FROM watchlist WHERE user_id = ? ORDER BY added_at").all(req.auth!.sub) as { symbol: string }[];
    res.json(rows.map((w) => s.market.snapshot(w.symbol)).filter(Boolean));
  });
  r.post(
    "/watchlist/:symbol",
    guard,
    asyncHandler((req, res) => {
      const symbol = req.params.symbol.toUpperCase();
      if (!INSTRUMENT_MAP.has(symbol)) throw new Error("Valeur inconnue");
      s.db.prepare("INSERT OR IGNORE INTO watchlist(user_id, symbol, added_at) VALUES (?,?,?)").run(req.auth!.sub, symbol, Date.now());
      res.status(201).json({ ok: true });
    }),
  );
  r.delete("/watchlist/:symbol", guard, (req, res) => {
    s.db.prepare("DELETE FROM watchlist WHERE user_id = ? AND symbol = ?").run(req.auth!.sub, req.params.symbol.toUpperCase());
    res.json({ ok: true });
  });

  // ---------- Alertes ----------
  r.get("/alerts", guard, (req, res) => res.json(s.alerts.list(req.auth!.sub)));
  r.post(
    "/alerts",
    guard,
    asyncHandler((req, res) => {
      const body = z.object({ symbol: z.string(), condition: z.enum(["above", "below", "pct_move"]), value: z.number().positive() }).parse(req.body);
      const symbol = body.symbol.toUpperCase();
      if (!INSTRUMENT_MAP.has(symbol)) throw new Error("Valeur inconnue");
      res.status(201).json(s.alerts.create(req.auth!.sub, symbol, body.condition, body.value));
    }),
  );
  r.delete("/alerts/:id", guard, (req, res) => {
    s.alerts.remove(req.auth!.sub, Number(req.params.id));
    res.json({ ok: true });
  });

  return r;
}
