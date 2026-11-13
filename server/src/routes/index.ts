import { Router } from "express";
import { z } from "zod";
import { INSTRUMENTS, INSTRUMENT_MAP, SECTORS } from "../data/instruments.js";
import { backtest } from "../engine/backtest.js";
import { config } from "../config.js";
import { CHECK_LABELS } from "../services/dataquality.js";
import { indicatorSeries } from "../engine/technical.js";
import { POINTS, ROLES, type AuthService, type Role } from "../services/auth.js";
import type { SocialService } from "../services/social.js";
import type { SignalService } from "../services/signals.js";
import type { SgiService, SgiOrderStatus } from "../services/sgi.js";
import type { AdvisoryService } from "../services/advisory.js";
import type { NewsService } from "../services/news.js";
import type { ForecastService } from "../services/forecast.js";
import type { LearningService } from "../services/learning.js";
import type { HoldingsService } from "../services/holdings.js";
import type { TrackingService } from "../services/tracking.js";
import type { ModelPortfolioService } from "../services/models.js";
import type { DataQualityService } from "../services/dataquality.js";
import type { AttributionService } from "../services/attribution.js";
import type { BondService } from "../services/bonds.js";
import type { DocumentService } from "../services/documents.js";
import type { QualityService } from "../services/quality.js";
import type { RadarService, RadarKind } from "../services/radar.js";
import type { CorporateService } from "../services/corporate.js";
import type { BocService } from "../services/boc.js";
import type { EvaluationService } from "../services/evaluation.js";
import type { FundamentalsService } from "../services/fundamentals.js";
import type { PanelService } from "../services/panel.js";
import type { HistoryService } from "../services/history.js";
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
  advisory: AdvisoryService;
  news: NewsService;
  forecasts: ForecastService;
  learning: LearningService;
  holdings: HoldingsService;
  bonds: BondService;
  documents: DocumentService;
  quality: QualityService;
  radar: RadarService;
  corporate: CorporateService;
  boc: BocService;
  evaluation: EvaluationService;
  fundamentals: FundamentalsService;
  panel: PanelService;
  history: HistoryService;
  tracking: TrackingService;
  models: ModelPortfolioService;
  dataQuality: DataQualityService;
  attribution: AttributionService;
}

export function buildRouter(s: Services): Router {
  const r = Router();
  const guard = requireAuth(s.auth);

  // ---------- Santé ----------
  r.get("/health", (_req, res) => res.json({ ok: true, privateMode: config.privateMode, ...s.market.status() }));
  /** Mode privé : fonctions communautaires et guichet SGI désactivés. */
  const privateOff = (_req: unknown, res: { status(n: number): { json(b: unknown): void } }, next: () => void) => {
    if (config.privateMode) return res.status(403).json({ error: "Fonction désactivée : plateforme privée (PRIVATE_MODE)" });
    next();
  };
  r.use(["/social", "/sgi/console", "/account/referrals"], privateOff);

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
      if (config.privateMode) throw Object.assign(new Error("Plateforme privée : les inscriptions sont fermées"), { status: 403 });
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
  // ---------- Score de qualité et de risque, profils d'émetteurs, radar ----------
  r.get("/market/quality", (_req, res) => res.json({ items: s.quality.all(), rules: s.quality.rules() }));
  r.get("/market/quality/rules", (_req, res) => res.json(s.quality.rules()));
  r.get("/market/quality/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return res.status(404).json({ error: "Valeur inconnue" });
    res.json({ ...s.quality.assess(symbol), profile: s.quality.profile(symbol) });
  });
  r.get("/market/profile/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return res.status(404).json({ error: "Valeur inconnue" });
    res.json(s.quality.profile(symbol));
  });
  r.put(
    "/market/profile/:symbol",
    guard,
    asyncHandler((req, res) => {
      if (req.auth!.role !== "analyst" && req.auth!.role !== "admin") throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      const pct = z.number().min(0).max(100).nullable().optional();
      const body = z.object({ freeFloatPct: pct, mainHolderPct: pct, mainHolderName: z.string().max(120).nullable().optional(), statePct: pct, sharesOutstanding: z.number().positive().nullable().optional(), payoutRatioPct: z.number().min(0).max(1000).nullable().optional(), dividendYears: z.number().int().min(0).max(100).nullable().optional(), suspended: z.boolean().optional(), suspendedReason: z.string().max(300).nullable().optional(), note: z.string().max(1000).nullable().optional() }).parse(req.body);
      res.json({ profile: s.quality.saveProfile(req.params.symbol, body, req.auth!.sub), quality: s.quality.assess(req.params.symbol) });
    }),
  );
  r.get("/market/radar", (req, res) => {
    const kind = req.query.kind ? (String(req.query.kind) as RadarKind) : undefined;
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
    const since = req.query.since ? Number(req.query.since) : undefined;
    res.json({ items: s.radar.list({ kind, symbol, since, limit: Number(req.query.limit ?? 100) }), status: s.radar.status() });
  });
  r.post("/market/radar/scan", guard, (req, res) => {
    if (req.auth!.role !== "analyst" && req.auth!.role !== "admin") return res.status(403).json({ error: "Réservé aux analystes" });
    res.json({ inserted: s.radar.scan(), status: s.radar.status() });
  });

  // ---------- Documents des sociétés (rapports, états financiers, communiqués) ----------
  const staff = (req: { auth?: { role: string } }) => req.auth!.role === "analyst" || req.auth!.role === "admin";
  r.get("/market/documents", (req, res) => {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
    const kind = req.query.kind ? (String(req.query.kind) as import("../services/documents.js").DocumentKind) : undefined;
    res.json({ items: s.documents.list({ symbol, kind, q: req.query.q ? String(req.query.q) : undefined, limit: Number(req.query.limit ?? 100) }), status: s.documents.status() });
  });
  r.get("/market/documents/history/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return res.status(404).json({ error: "Valeur inconnue" });
    res.json(s.documents.history(symbol));
  });
  r.post(
    "/market/documents/refresh",
    guard,
    asyncHandler(async (req, res) => {
      if (!staff(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      const symbols = req.body?.symbols ? z.array(z.string().max(8)).max(60).parse(req.body.symbols).map((x) => x.toUpperCase()) : undefined;
      res.json({ inserted: await s.documents.refresh(symbols), status: s.documents.status() });
    }),
  );
  r.post(
    "/market/documents/import",
    guard,
    asyncHandler((req, res) => {
      if (!staff(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      const body = z.object({ text: z.string().min(5).max(200000), source: z.string().max(80).optional() }).parse(req.body);
      res.json({ ...s.documents.importText(body.text, body.source), status: s.documents.status() });
    }),
  );
  r.delete("/market/documents/:id", guard, (req, res) => {
    if (!staff(req)) return res.status(403).json({ error: "Réservé aux analystes" });
    s.documents.remove(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------- Compartiment obligataire ----------
  const bondSchema = z.object({
    code: z.string().min(3).max(16),
    name: z.string().min(3).max(120),
    issuer: z.string().min(2).max(120),
    issuerType: z.enum(["souverain", "supranational", "entreprise"]),
    country: z.string().length(2),
    couponPct: z.number().min(0).max(30),
    issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    maturityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    nominal: z.number().positive().default(10000),
    frequency: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1),
    amortization: z.enum(["in_fine", "constant", "annuite"]).default("constant"),
    graceYears: z.number().int().min(0).max(20).default(0),
    taxExempt: z.boolean().default(false),
    active: z.boolean().optional(),
  });
  const isAdmin = (req: { auth?: { role: string } }) => req.auth!.role === "admin";
  const isAnalyst = (req: { auth?: { role: string } }) => req.auth!.role === "analyst" || req.auth!.role === "admin";
  r.get("/market/bonds", (_req, res) => res.json({ items: s.bonds.list(), status: s.bonds.status(), note: "Cours en pourcentage du nominal restant dû, issus de la cote officielle de la BRVM lorsqu'elle est collectée (sinon indicatifs). Les dates de jouissance et le mode d'amortissement sont estimés d'après le libellé tant qu'un administrateur ne les a pas précisés." }));
  r.post(
    "/market/bonds/import-cote",
    guard,
    asyncHandler((req, res) => {
      if (!isAdmin(req)) throw Object.assign(new Error("Réservé à l'administrateur"), { status: 403 });
      const body = z.object({ text: z.string().min(10).max(200000) }).parse(req.body);
      res.json({ ...s.bonds.importCote(body.text), status: s.bonds.status() });
    }),
  );
  r.post(
    "/market/bonds/refresh",
    guard,
    asyncHandler(async (req, res) => {
      if (!isAdmin(req)) throw Object.assign(new Error("Réservé à l'administrateur"), { status: 403 });
      res.json({ lastRun: await s.bonds.refresh(), status: s.bonds.status() });
    }),
  );
  r.get("/market/bonds/suggest", (req, res) => res.json(s.bonds.suggest(Number(req.query.budget ?? 1_000_000), Number(req.query.horizon ?? 36), Math.min(8, Number(req.query.lines ?? 4)))));
  r.get("/market/bonds/:code", (req, res) => {
    const d = s.bonds.detail(req.params.code.toUpperCase());
    if (!d) return res.status(404).json({ error: "Obligation inconnue" });
    res.json(d);
  });
  r.post(
    "/market/bonds",
    guard,
    asyncHandler((req, res) => {
      if (!isAdmin(req)) throw Object.assign(new Error("Réservé à l'administrateur"), { status: 403 });
      res.status(201).json(s.bonds.upsert(bondSchema.parse(req.body)));
    }),
  );
  r.put(
    "/market/bonds/:code/price",
    guard,
    asyncHandler((req, res) => {
      if (!isAdmin(req)) throw Object.assign(new Error("Réservé à l'administrateur"), { status: 403 });
      const body = z.object({ pricePct: z.number().positive().max(300).nullable() }).parse(req.body);
      res.json(s.bonds.setPrice(req.params.code.toUpperCase(), body.pricePct));
    }),
  );
  r.delete("/market/bonds/:code", guard, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "Réservé à l'administrateur" });
    s.bonds.deactivate(req.params.code.toUpperCase());
    res.json({ ok: true });
  });
  r.post(
    "/market/bonds/import",
    guard,
    asyncHandler((req, res) => {
      if (!isAdmin(req)) throw Object.assign(new Error("Réservé à l'administrateur"), { status: 403 });
      const body = z.object({ text: z.string().max(50000) }).parse(req.body);
      const imported: string[] = [];
      const rejected: string[] = [];
      for (const raw of body.text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || /^code/i.test(line)) continue;
        const c = line.split(/[;\t]/).map((x) => x.trim());
        try {
          const b = bondSchema.parse({ code: c[0], name: c[1], issuer: c[2], issuerType: c[3], country: c[4], couponPct: Number(c[5]), issueDate: c[6], maturityDate: c[7], nominal: c[8] ? Number(c[8]) : 10000, frequency: c[9] ? Number(c[9]) : 1, amortization: c[10] || "constant", graceYears: c[11] ? Number(c[11]) : 0, taxExempt: /^(1|oui|true|o)$/i.test(c[12] ?? "") });
          s.bonds.upsert(b);
          imported.push(b.code.toUpperCase());
        } catch {
          rejected.push(line);
        }
      }
      res.json({ imported, rejected });
    }),
  );
  // ---------- Données officielles : bulletin de la cote, actions sur le capital, dividendes ----------
  r.get("/market/boc", (req, res) => res.json({ ...s.boc.session(req.query.ts ? Number(req.query.ts) : undefined), status: s.boc.status() }));
  r.get("/market/boc/status", (_req, res) => res.json(s.boc.status()));
  r.get("/market/boc/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return res.status(404).json({ error: "Valeur inconnue" });
    res.json({ symbol, latest: s.boc.latest(symbol), activity: s.boc.activity(symbol), stats: s.boc.stats(symbol, Math.min(500, Number(req.query.limit ?? 60))) });
  });
  r.post(
    "/market/boc/import",
    guard,
    asyncHandler((req, res) => {
      if (!isAdmin(req)) throw Object.assign(new Error("Réservé à l'administrateur"), { status: 403 });
      const body = z.object({ text: z.string().min(5).max(500000), date: z.string().optional() }).parse(req.body);
      const ts = body.date ? Date.parse(body.date) : NaN;
      res.json({ ...s.boc.importText(body.text, Number.isFinite(ts) ? ts : null, "import"), status: s.boc.status() });
    }),
  );
  r.post(
    "/market/boc/refresh",
    guard,
    asyncHandler(async (req, res) => {
      if (!isAdmin(req)) throw Object.assign(new Error("Réservé à l'administrateur"), { status: 403 });
      res.json({ lastRun: await s.boc.refresh(!!req.body?.force), status: s.boc.status() });
    }),
  );
  r.get("/market/corporate", (req, res) => {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
    res.json({ actions: s.corporate.actions(symbol), dividends: s.corporate.dividends(symbol), status: s.corporate.status() });
  });
  r.get("/market/corporate/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return res.status(404).json({ error: "Valeur inconnue" });
    const price = s.market.price(symbol);
    res.json({ symbol, actions: s.corporate.actions(symbol), dividends: s.corporate.dividends(symbol), info: s.corporate.dividendInfo(symbol, price), adjustments: s.market.adjustmentSteps(symbol) });
  });
  const actionSchema = z.object({ symbol: z.string().min(2), kind: z.enum(["split", "reverse_split", "bonus"]), exDate: z.string().min(8), ratio: z.number().positive(), note: z.string().max(500).nullable().optional(), status: z.enum(["confirmé", "suspecté"]).optional() });
  r.post(
    "/market/corporate/actions",
    guard,
    asyncHandler((req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      res.status(201).json(s.corporate.upsertAction(actionSchema.parse(req.body), req.auth!.sub));
    }),
  );
  r.post("/market/corporate/actions/detect", guard, (req, res) => {
    if (!isAnalyst(req)) return res.status(403).json({ error: "Réservé aux analystes" });
    res.json(s.corporate.detect());
  });
  r.post("/market/corporate/actions/:id/confirm", guard, (req, res) => {
    if (!isAnalyst(req)) return res.status(403).json({ error: "Réservé aux analystes" });
    try { res.json(s.corporate.confirmAction(Number(req.params.id), req.auth!.sub)); } catch (e) { res.status(404).json({ error: (e as Error).message }); }
  });
  r.delete("/market/corporate/actions/:id", guard, (req, res) => {
    if (!isAnalyst(req)) return res.status(403).json({ error: "Réservé aux analystes" });
    s.corporate.removeAction(Number(req.params.id));
    res.json({ ok: true });
  });
  const dividendSchema = z.object({ symbol: z.string().min(2), fiscalYear: z.number().int(), gross: z.number().positive().nullable().optional(), net: z.number().positive().nullable().optional(), exDate: z.string().nullable().optional(), paymentDate: z.string().nullable().optional(), agmDate: z.string().nullable().optional(), status: z.enum(["proposé", "approuvé", "payé"]).optional(), url: z.string().url().nullable().optional(), note: z.string().max(500).nullable().optional() });
  r.post(
    "/market/corporate/dividends",
    guard,
    asyncHandler((req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      res.status(201).json(s.corporate.upsertDividend(dividendSchema.parse(req.body), req.auth!.sub));
    }),
  );
  r.post(
    "/market/corporate/dividends/import",
    guard,
    asyncHandler((req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      const body = z.object({ text: z.string().min(5).max(100000) }).parse(req.body);
      res.json(s.corporate.importDividends(body.text, req.auth!.sub));
    }),
  );
  r.post("/market/corporate/dividends/scan", guard, (req, res) => {
    if (!isAnalyst(req)) return res.status(403).json({ error: "Réservé aux analystes" });
    res.json({ inserted: s.corporate.ingestRecent() });
  });
  r.delete("/market/corporate/dividends/:id", guard, (req, res) => {
    if (!isAnalyst(req)) return res.status(403).json({ error: "Réservé aux analystes" });
    s.corporate.removeDividend(Number(req.params.id));
    res.json({ ok: true });
  });
  // ---------- Collecteurs : historique réel, dividendes Sika, état d'ensemble ----------
  r.get("/market/history-status", (_req, res) => res.json(s.history.status()));
  r.post(
    "/market/history-status/refresh",
    guard,
    asyncHandler(async (req, res) => {
      if (!isAdmin(req)) throw Object.assign(new Error("Réservé à l'administrateur"), { status: 403 });
      const body = z.object({ symbols: z.array(z.string()).max(60).optional() }).parse(req.body ?? {});
      res.json({ lastRun: await s.history.refresh(body.symbols?.map((x) => x.toUpperCase())), status: s.history.status() });
    }),
  );
  r.post(
    "/market/corporate/dividends/sika",
    guard,
    asyncHandler(async (req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      res.json(await s.corporate.refreshFromSika());
    }),
  );
  r.get("/market/collectors", (_req, res) => {
    res.json({
      quotes: s.market.status(),
      history: (() => { const h = s.history.status(); return { source: h.source, realCoverage: h.realCoverage, lastRun: h.lastRun, lastCapRun: h.lastCapRun }; })(),
      bulletin: s.boc.status(),
      bonds: s.bonds.status(),
      news: s.news.status(),
      documents: s.documents.status(),
      dividends: { ...s.corporate.status(), lastSikaRun: s.corporate.lastSikaRun },
      fundamentals: s.fundamentals.status(),
      panel: (() => { const p = s.panel.summary(); return { asOf: p.asOf, computedAt: p.computedAt, symbols: p.symbols }; })(),
      policy: { brvm: "délai de 10 s entre deux requêtes (robots.txt)", sika: "documents /docs non téléchargés (robots.txt), délai 2 s", richbourse: "extraction automatique refusée par le site : exports CSV à importer à la main" },
    });
  });

  // ---------- Fondamentaux et modèle de panel ----------
  r.get("/market/fundamentals", (_req, res) => res.json({ items: s.fundamentals.all(), status: s.fundamentals.status() }));
  r.get("/market/fundamentals/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return res.status(404).json({ error: "Valeur inconnue" });
    res.json(s.fundamentals.company(symbol));
  });
  const fundamentalSchema = z.object({ symbol: z.string().min(2), period: z.string().min(4).max(12), periodEnd: z.string().nullable().optional(), publishedAt: z.string().nullable().optional(), revenue: z.number().nullable().optional(), netIncome: z.number().nullable().optional(), equity: z.number().nullable().optional(), shares: z.number().positive().nullable().optional(), eps: z.number().nullable().optional(), dps: z.number().nullable().optional(), revenueGrowthPct: z.number().nullable().optional(), netIncomeGrowthPct: z.number().nullable().optional(), url: z.string().url().nullable().optional(), note: z.string().max(500).nullable().optional() });
  r.post(
    "/market/fundamentals",
    guard,
    asyncHandler((req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      res.status(201).json(s.fundamentals.upsert(fundamentalSchema.parse(req.body), req.auth!.sub));
    }),
  );
  r.post(
    "/market/fundamentals/import",
    guard,
    asyncHandler((req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      const body = z.object({ text: z.string().min(5).max(200000) }).parse(req.body);
      res.json(s.fundamentals.importText(body.text, req.auth!.sub));
    }),
  );
  r.post(
    "/market/fundamentals/scan",
    guard,
    asyncHandler(async (req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      res.json({ ...(await s.fundamentals.scan(!!req.body?.fetch)), status: s.fundamentals.status() });
    }),
  );
  r.delete("/market/fundamentals/:id", guard, (req, res) => {
    if (!isAnalyst(req)) return res.status(403).json({ error: "Réservé aux analystes" });
    s.fundamentals.remove(Number(req.params.id));
    res.json({ ok: true });
  });
  r.get("/market/panel", (req, res) => res.json(s.panel.summary((String(req.query.horizon ?? "1M") as "1W" | "1M" | "3M"))));

  // ---------- Évaluation en marche avant du moteur de prévision ----------
  r.get("/market/evaluation", (_req, res) => res.json({ latest: s.evaluation.latest(), status: s.evaluation.status() }));
  r.get("/market/evaluation/history", (req, res) => res.json(s.evaluation.history(Math.min(100, Number(req.query.limit ?? 20)))));
  r.get("/market/evaluation/:id", (req, res) => {
    const rep = s.evaluation.get(Number(req.params.id));
    if (!rep) return res.status(404).json({ error: "Rapport inconnu" });
    res.json(rep);
  });
  r.post(
    "/market/evaluation/run",
    guard,
    asyncHandler((req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      const body = z.object({ sessions: z.number().int().min(60).max(2000).optional(), step: z.number().int().min(1).max(60).optional(), topK: z.number().int().min(1).max(20).optional(), feePct: z.number().min(0).max(10).optional(), panel: z.boolean().optional() }).parse(req.body ?? {});
      const started = s.evaluation.run(body);
      res.status(started ? 202 : 409).json({ started, status: s.evaluation.status() });
    }),
  );
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
    const adjusted = req.query.adjusted === "1" || req.query.adjusted === "true";
    const candles = s.market.historyAggregated(symbol, tf, limit, adjusted);
    res.json({ symbol, timeframe: tf, candles, adjusted, adjustments: adjusted ? s.market.adjustmentSteps(symbol) : [], indicators: tf === "1m" ? null : indicatorSeries(candles) });
  });
  r.get("/market/ticks/:symbol", (req, res) => res.json(s.market.recentTicks(req.params.symbol.toUpperCase(), Number(req.query.limit ?? 50))));
  r.get("/market/screener", (_req, res) => res.json(s.advisor.marketScreener()));
  r.get("/market/technical/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return res.status(404).json({ error: "Valeur inconnue" });
    res.json(s.advisor.technical(symbol));
  });
  r.get("/market/forecast/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return res.status(404).json({ error: "Valeur inconnue" });
    res.json(s.forecasts.get(symbol));
  });
  r.get("/market/forecasts/learning", (_req, res) => res.json(s.learning.summary()));
  r.get("/market/forecasts/journal/:symbol", (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return res.status(404).json({ error: "Valeur inconnue" });
    res.json(s.learning.journal(symbol, Math.min(200, Number(req.query.limit ?? 30))));
  });
  r.post(
    "/market/forecasts/learn",
    guard,
    asyncHandler((req, res) => {
      if (req.auth!.role !== "analyst" && req.auth!.role !== "admin") throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      res.json({ ...s.learning.runCycle(), summary: s.learning.summary() });
    }),
  );
  r.get("/market/forecasts", (req, res) => {
    const h = String(req.query.horizon ?? "1M");
    res.json(s.forecasts.ranking(h === "1W" || h === "3M" ? h : "1M"));
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
    const all = [...s.corporate.calendar(year), ...s.corporate.calendar(year + 1)];
    res.json(all.filter((e) => e.date >= from && e.date <= to && (!symbol || e.symbol === symbol || e.symbol === null)));
  });
  r.get("/market/news", (req, res) => {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
    res.json({ items: s.news.latest(Math.min(200, Number(req.query.limit ?? 50)), symbol), market: s.news.marketSentiment(), symbolSentiment: symbol ? s.news.sentimentFor(symbol) : null, status: s.news.status() });
  });
  r.post(
    "/market/news",
    guard,
    asyncHandler((req, res) => {
      if (req.auth!.role !== "analyst" && req.auth!.role !== "admin") throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      const body = z.object({ source: z.string().min(2).max(60), title: z.string().min(5).max(300), url: z.string().url(), summary: z.string().max(1000).optional(), publishedAt: z.number().optional() }).parse(req.body);
      res.status(201).json(s.news.addManual(body.source, body.title, body.url, body.summary ?? null, body.publishedAt));
    }),
  );
  r.post(
    "/market/news/refresh",
    guard,
    asyncHandler(async (req, res) => {
      if (req.auth!.role !== "analyst" && req.auth!.role !== "admin") throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      res.json({ inserted: await s.news.refresh(), status: s.news.status() });
    }),
  );
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

  // ---------- Portefeuille détenu (saisi par l'utilisateur) et son analyse ----------
  const heldLine = z.object({ symbol: z.string().min(2).max(16), quantity: z.number().positive().max(1e9), avgPrice: z.number().positive().optional().nullable(), acquiredAt: z.number().optional().nullable(), note: z.string().max(200).optional().nullable() });
  const toLine = (l: z.infer<typeof heldLine>) => ({ symbol: l.symbol.toUpperCase(), quantity: l.quantity, avgPrice: l.avgPrice ?? null, acquiredAt: l.acquiredAt ?? null, note: l.note ?? null });
  r.get("/holdings", guard, (req, res) => res.json(s.holdings.get(req.auth!.sub)));
  r.put(
    "/holdings",
    guard,
    asyncHandler((req, res) => {
      const body = z.object({ label: z.string().max(80).optional().nullable(), cash: z.number().min(0).max(1e13).optional(), positions: z.array(heldLine).max(100) }).parse(req.body);
      res.json(s.holdings.replace(req.auth!.sub, { label: body.label, cash: body.cash, positions: body.positions.map(toLine) }));
    }),
  );
  r.post(
    "/holdings/line",
    guard,
    asyncHandler((req, res) => res.json(s.holdings.upsertLine(req.auth!.sub, toLine(heldLine.parse(req.body))))),
  );
  r.delete("/holdings/line/:symbol", guard, (req, res) => res.json(s.holdings.removeLine(req.auth!.sub, req.params.symbol)));
  r.put(
    "/holdings/cash",
    guard,
    asyncHandler((req, res) => {
      const body = z.object({ cash: z.number().min(0).max(1e13), label: z.string().max(80).optional().nullable() }).parse(req.body);
      res.json(s.holdings.setCash(req.auth!.sub, body.cash, body.label));
    }),
  );
  r.post(
    "/holdings/import",
    guard,
    asyncHandler((req, res) => {
      const body = z.object({ text: z.string().max(20000), replace: z.boolean().optional(), cash: z.number().min(0).optional() }).parse(req.body);
      const parsed = s.holdings.parseImport(body.text);
      if (body.replace === false) {
        for (const p of parsed.positions) s.holdings.upsertLine(req.auth!.sub, p);
        res.json({ ...s.holdings.get(req.auth!.sub), imported: parsed.positions.length, rejected: parsed.rejected });
      } else {
        const current = s.holdings.get(req.auth!.sub);
        res.json({ ...s.holdings.replace(req.auth!.sub, { label: current.label, cash: body.cash ?? current.cash, positions: parsed.positions }), imported: parsed.positions.length, rejected: parsed.rejected });
      }
    }),
  );
  r.post("/holdings/import-virtual", guard, (req, res) => res.json(s.holdings.importVirtual(req.auth!.sub)));
  r.get("/holdings/analysis", guard, (req, res) => res.json(s.holdings.analyze(req.auth!.sub)));

  // ---- Suivi réel des portefeuilles recommandés ----
  r.get("/tracking", guard, (req, res) => res.json({ items: s.tracking.list(req.auth!.sub) }));
  r.get("/tracking/:id", guard, (req, res) => {
    const v = s.tracking.view(req.auth!.sub, Number(req.params.id));
    if (!v) return res.status(404).json({ error: "Portefeuille suivi inconnu" });
    res.json(v);
  });
  const trackingSchema = z.object({ kind: z.enum(["conseil", "cible", "manuel"]), label: z.string().min(1).max(120), capital: z.number().positive(), lines: z.array(z.object({ symbol: z.string().min(2).max(10), weightPct: z.number().min(0).max(100) })).min(1).max(40), sourceId: z.number().int().optional() });
  r.post(
    "/tracking",
    guard,
    asyncHandler((req, res) => {
      const body = trackingSchema.parse(req.body);
      res.status(201).json(s.tracking.create(req.auth!.sub, body));
    }),
  );
  r.delete("/tracking/:id", guard, (req, res) => res.json({ removed: s.tracking.remove(req.auth!.sub, Number(req.params.id)) }));
  r.post(
    "/holdings/analysis",
    guard,
    asyncHandler((req, res) => {
      const body = z.object({ cash: z.number().min(0).max(1e13).optional(), positions: z.array(heldLine).max(100) }).parse(req.body);
      res.json(s.holdings.analyze(req.auth!.sub, { cash: body.cash ?? 0, positions: body.positions.map(toLine) }));
    }),
  );

  // ---------- Guichet de conseil en investissement (clients et SGI) ----------
  const advisorySchema = z.object({
    capital: z.number().positive().max(1e12),
    objective: z.enum(["income", "growth", "balanced", "speculative"]),
    horizonMonths: z.number().int().min(1).max(480),
    riskTolerance: z.number().int().min(1).max(5),
    preferredSectors: z.array(z.string()).max(10).optional(),
    constraints: z.string().max(600).optional(),
    holdings: z.array(z.object({ symbol: z.string().min(2).max(16), quantity: z.number().int().positive(), avgPrice: z.number().positive().optional() })).max(60).optional(),
    clientLabel: z.string().max(120).optional(),
    /** une SGI peut aussi demander un conseil pour elle-même */
    asSgi: z.boolean().optional(),
    targetYieldPct: z.number().min(0).max(100).optional(),
    maxLines: z.number().int().min(2).max(15).optional(),
    maxWeightPct: z.number().min(5).max(60).optional(),
    excludedSectors: z.array(z.string()).max(20).optional(),
    excludedSymbols: z.array(z.string().max(16)).max(60).optional(),
    bondSharePct: z.number().min(0).max(80).optional(),
    returnModel: z.enum(["black_litterman", "views"]).optional(),
  });
  r.post(
    "/advisory/requests",
    guard,
    asyncHandler((req, res) => {
      const body = advisorySchema.parse(req.body);
      const staffCode = s.sgi.staffSgiCode(req.auth!.sub);
      const asSgi = !config.privateMode && !!staffCode && req.auth!.role === "sgi" && body.asSgi !== false;
      const view = s.advisory.create(req.auth!.sub, asSgi ? "sgi" : "client", asSgi ? staffCode : null, { ...body, holdings: body.holdings?.map((h) => ({ ...h, symbol: h.symbol.toUpperCase() })) });
      res.status(201).json(view);
    }),
  );
  r.post(
    "/advisory/preview",
    guard,
    asyncHandler((req, res) => {
      const body = advisorySchema.parse(req.body);
      res.json(s.advisory.generateReport({ ...body, holdings: body.holdings?.map((h) => ({ ...h, symbol: h.symbol.toUpperCase() })) }));
    }),
  );
  // ---- Attribution de performance ----
  r.get("/attribution/holdings", guard, asyncHandler((req, res) => {
    const period = (["1M", "3M", "6M", "YTD", "1Y"] as const).find((p) => p === req.query.period) ?? "3M";
    res.json(s.attribution.forHoldings(req.auth!.sub, period));
  }));
  r.get("/attribution/tracking/:id", guard, (req, res) => {
    const rep = s.attribution.forTrackedId(req.auth!.sub, Number(req.params.id));
    if (!rep) return res.status(404).json({ error: "Portefeuille suivi inconnu" });
    res.json(rep);
  });
  r.get("/attribution/models/:key", guard, (req, res) => {
    const m = s.models.view(req.params.key);
    if (!m) return res.status(404).json({ error: "Modèle inconnu" });
    if (m.trackingId == null) return res.status(404).json({ error: "Modèle non publié" });
    const rep = s.attribution.forTrackingAnyId(m.trackingId);
    if (!rep) return res.status(404).json({ error: "Suivi introuvable" });
    res.json({ ...rep, subject: { kind: "tracking", id: m.trackingId, label: `Modèle ${m.label} v${m.version}` } });
  });

  // ---- Qualité des données et rapport du jour ----
  r.get("/quality", guard, (_req, res) => res.json({ run: s.dataQuality.latestRun(), history: s.dataQuality.scoreHistory(30), status: s.dataQuality.status(), labels: CHECK_LABELS }));
  r.post(
    "/quality/run",
    guard,
    asyncHandler((req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      res.json({ run: s.dataQuality.runChecks(), history: s.dataQuality.scoreHistory(30), status: s.dataQuality.status(), labels: CHECK_LABELS });
    }),
  );
  r.get("/quality/daily", guard, (_req, res) => {
    const reports = s.dataQuality.reports(14);
    res.json({ report: reports[0] ?? null, previous: reports[1] ?? null, history: reports });
  });
  r.post(
    "/quality/daily/run",
    guard,
    asyncHandler((req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      const report = s.dataQuality.dailyReport();
      const reports = s.dataQuality.reports(14);
      res.json({ report, previous: reports[1] ?? null, history: reports });
    }),
  );

  // ---- Portefeuilles modèles par profil ----
  r.get("/models", guard, (_req, res) => res.json({ items: s.models.list(), status: s.models.status() }));
  r.get("/models/:key", guard, (req, res) => {
    const v = s.models.view(req.params.key);
    if (!v) return res.status(404).json({ error: "Modèle inconnu" });
    res.json({ ...v, versions: s.models.versions(req.params.key), series: v.trackingId != null ? s.tracking.seriesById(v.trackingId) : [] });
  });
  r.get("/models/:key/plan", guard, asyncHandler((req, res) => res.json(s.models.planFor(req.auth!.sub, req.params.key as "prudent"))));
  r.post(
    "/models/recompute",
    guard,
    asyncHandler(async (req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      res.json({ ...(await s.models.recompute()), items: s.models.list() });
    }),
  );
  r.post(
    "/models/:key/publish",
    guard,
    asyncHandler((req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      const body = z.object({ note: z.string().max(500).optional().nullable() }).parse(req.body ?? {});
      res.json(s.models.publish(req.params.key as "prudent", req.auth!.sub, body.note ?? null));
    }),
  );
  r.get("/advisory/requests", guard, (req, res) => {
    const staffCode = s.sgi.staffSgiCode(req.auth!.sub);
    res.json(staffCode && req.auth!.role === "sgi" ? s.advisory.listForSgi(staffCode) : s.advisory.listForUser(req.auth!.sub));
  });
  r.get(
    "/advisory/requests/:id",
    guard,
    asyncHandler((req, res) => {
      const v = s.advisory.get(Number(req.params.id));
      const staffCode = s.sgi.staffSgiCode(req.auth!.sub);
      if (!v || (v.user_id !== req.auth!.sub && !isAnalyst(req) && !(staffCode && v.sgi_code === staffCode))) throw new Error("Demande introuvable");
      res.json(v);
    }),
  );
  r.post(
    "/advisory/requests/:id/regenerate",
    guard,
    asyncHandler((req, res) => res.json(s.advisory.regenerate(Number(req.params.id), isAnalyst(req) ? null : req.auth!.sub))),
  );
  r.get(
    "/advisory/inbox",
    guard,
    asyncHandler((req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      res.json({ requests: s.advisory.inbox(), stats: s.advisory.stats() });
    }),
  );
  r.post(
    "/advisory/requests/:id/review",
    guard,
    asyncHandler((req, res) => {
      if (!isAnalyst(req)) throw Object.assign(new Error("Réservé aux analystes"), { status: 403 });
      const body = z.object({ decision: z.enum(["validated", "declined"]), note: z.string().max(2000).optional() }).parse(req.body);
      res.json(s.advisory.review(req.auth!.sub, Number(req.params.id), body.decision, body.note));
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
