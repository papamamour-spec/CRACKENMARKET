import type { DB } from "../db/index.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../data/instruments.js";
import { buildBehaviorProfile, type BehaviorProfile, type DeclaredProfile, type PositionRecord } from "../engine/behavior.js";
import { diagnosePortfolio, proposeAllocation, recommend, type Recommendation } from "../engine/advisor.js";
import { analyze, type TechnicalSnapshot } from "../engine/technical.js";
import type { MarketService } from "./market.js";
import type { PortfolioService } from "./portfolio.js";
import type { NewsService } from "./news.js";

const TECH_TTL_MS = 60_000;

export class AdvisorService {
  private techCache = new Map<string, { at: number; snap: TechnicalSnapshot }>();

  private news: NewsService | null = null;

  constructor(
    private readonly db: DB,
    private readonly market: MarketService,
    private readonly portfolios: PortfolioService,
  ) {
    // invalider le cache technique d'une valeur dès qu'elle cote
    market.on("quotes", (qs: { symbol: string }[]) => {
      for (const q of qs) this.techCache.delete(q.symbol);
    });
  }

  /** Branche la veille d'actualité : son sentiment tempère les recommandations. */
  attachNews(news: NewsService): void {
    this.news = news;
  }

  newsContext() {
    return this.news?.sentimentMap() ?? new Map();
  }

  technical(symbol: string): TechnicalSnapshot {
    const cached = this.techCache.get(symbol);
    if (cached && Date.now() - cached.at < TECH_TTL_MS) return cached.snap;
    const snap = analyze(symbol, this.market.history(symbol, 400));
    this.techCache.set(symbol, { at: Date.now(), snap });
    return snap;
  }

  declaredProfile(userId: number): DeclaredProfile {
    const row = this.db.prepare("SELECT * FROM investor_profiles WHERE user_id = ?").get(userId) as
      | { risk_tolerance: number; horizon_months: number; objective: DeclaredProfile["objective"]; experience: DeclaredProfile["experience"]; monthly_capacity: number; preferred_sectors: string }
      | undefined;
    if (!row) return { riskTolerance: 3, horizonMonths: 24, objective: "growth", experience: "beginner", monthlyCapacity: 0, preferredSectors: [] };
    return {
      riskTolerance: row.risk_tolerance,
      horizonMonths: row.horizon_months,
      objective: row.objective,
      experience: row.experience,
      monthlyCapacity: row.monthly_capacity,
      preferredSectors: JSON.parse(row.preferred_sectors || "[]"),
    };
  }

  saveDeclaredProfile(userId: number, p: DeclaredProfile): void {
    this.db
      .prepare(
        `INSERT INTO investor_profiles(user_id, risk_tolerance, horizon_months, objective, experience, monthly_capacity, preferred_sectors, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET risk_tolerance=excluded.risk_tolerance, horizon_months=excluded.horizon_months, objective=excluded.objective,
           experience=excluded.experience, monthly_capacity=excluded.monthly_capacity, preferred_sectors=excluded.preferred_sectors, updated_at=excluded.updated_at`,
      )
      .run(userId, p.riskTolerance, p.horizonMonths, p.objective, p.experience, p.monthlyCapacity, JSON.stringify(p.preferredSectors), Date.now());
  }

  behaviorProfile(userId: number): BehaviorProfile {
    const declared = this.declaredProfile(userId);
    const trades = this.portfolios.trades(userId);
    const events = this.db.prepare("SELECT kind, symbol, ts FROM behavior_events WHERE user_id = ? ORDER BY ts DESC LIMIT 2000").all(userId) as {
      kind: string;
      symbol: string | null;
      ts: number;
    }[];
    return buildBehaviorProfile(declared, trades, events, this.positionRecords(userId));
  }

  private positionRecords(userId: number): PositionRecord[] {
    const pf = this.portfolios.getForUser(userId);
    return this.portfolios.positions(pf.id).map((p) => ({ symbol: p.symbol, quantity: p.quantity, avgPrice: p.avgPrice, currentPrice: p.currentPrice, sector: p.sector }));
  }

  recommendations(userId: number): { profile: BehaviorProfile; recommendations: Recommendation[] } {
    const profile = this.behaviorProfile(userId);
    const pf = this.portfolios.getForUser(userId);
    const positions = this.positionRecords(userId);
    const ctx = { profile, positions, cash: pf.cash, news: this.newsContext() };
    const recs = INSTRUMENTS.map((i) => recommend(this.technical(i.symbol), ctx)).sort((a, b) => b.score - a.score);
    return { profile, recommendations: recs };
  }

  recommendationFor(userId: number, symbol: string): Recommendation {
    const profile = this.behaviorProfile(userId);
    const pf = this.portfolios.getForUser(userId);
    return recommend(this.technical(symbol), { profile, positions: this.positionRecords(userId), cash: pf.cash, news: this.newsContext() });
  }

  portfolioDiagnostic(userId: number) {
    const { profile, recommendations } = this.recommendations(userId);
    const pf = this.portfolios.getForUser(userId);
    const positions = this.positionRecords(userId);
    const map = new Map(recommendations.map((r) => [r.symbol, r]));
    const diagnostic = diagnosePortfolio({ profile, positions, cash: pf.cash }, map);
    const allocation = proposeAllocation(recommendations, profile, pf.cash + positions.reduce((a, p) => a + p.quantity * p.currentPrice, 0));
    return { profile, diagnostic, allocation, topIdeas: recommendations.filter((r) => !r.held).slice(0, 5) };
  }

  /** Classement marché (sans profil) : score composite technique. */
  marketScreener() {
    return INSTRUMENTS.map((i) => {
      const t = this.technical(i.symbol);
      const s = this.market.snapshot(i.symbol);
      return {
        symbol: i.symbol,
        name: i.name,
        sector: i.sector,
        price: s?.price ?? t.price,
        changePct: s?.changePct ?? 0,
        composite: Math.round(t.scores.composite * 100),
        trend: Math.round(t.scores.trend * 100),
        momentum: Math.round(t.scores.momentum * 100),
        rsi: Math.round(t.rsi14),
        volatility: Math.round(t.volatility60 * 100),
        perf1m: Math.round(t.perf1m * 10) / 10,
        perf1y: Math.round(t.perf1y * 10) / 10,
        dividendYield: i.dividendYield,
        signals: t.signals,
      };
    }).sort((a, b) => b.composite - a.composite);
  }

  recordView(userId: number, symbol: string): void {
    if (!INSTRUMENT_MAP.has(symbol)) return;
    this.db.prepare("INSERT INTO behavior_events(user_id, kind, symbol, payload, ts) VALUES (?,?,?,?,?)").run(userId, "view", symbol, null, Date.now());
  }

  recordAdviceFeedback(userId: number, symbol: string, followed: boolean): void {
    this.db
      .prepare("INSERT INTO behavior_events(user_id, kind, symbol, payload, ts) VALUES (?,?,?,?,?)")
      .run(userId, followed ? "advice_followed" : "advice_ignored", symbol, null, Date.now());
  }
}
