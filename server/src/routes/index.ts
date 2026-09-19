import { Router } from "express";
import { z } from "zod";
import { INSTRUMENTS, INSTRUMENT_MAP, SECTORS } from "../data/instruments.js";
import { backtest } from "../engine/backtest.js";
import { config } from "../config.js";
import { indicatorSeries } from "../engine/technical.js";
import { ROLES, type AuthService, type Role } from "../services/auth.js";
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
  });
  r.post(
    "/auth/register",
    asyncHandler((req, res) => {
      const body = registerSchema.parse(req.body);
      const role = body.role === "admin" ? "investor" : (body.role ?? "investor");
      const user = s.auth.register(body.email, body.password, body.fullName, role);
      res.status(201).json({ user, token: s.auth.sign(user) });
    }),
  );
  r.post(
    "/auth/login",
    asyncHandler((req, res) => {
      const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
      const user = s.auth.login(body.email, body.password);
      res.json({ user, token: s.auth.sign(user) });
    }),
  );
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
  const orderSchema = z.object({
    symbol: z.string().min(2).max(6),
    side: z.enum(["buy", "sell"]),
    type: z.enum(["market", "limit"]).default("market"),
    quantity: z.number().int().positive(),
    limitPrice: z.number().positive().optional(),
    note: z.string().max(200).optional(),
  });
  r.post(
    "/portfolio/orders",
    guard,
    asyncHandler((req, res) => {
      const body = orderSchema.parse(req.body);
      const order = s.portfolios.placeOrder(req.auth!.sub, { ...body, symbol: body.symbol.toUpperCase() });
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
