import type { DB } from "../db/index.js";
import { maskName } from "./auth.js";
import type { PortfolioService } from "./portfolio.js";
import { startOfDayUtc } from "./market.js";

export interface LeaderboardEntry {
  userId: number;
  displayName: string;
  role: string;
  totalReturnPct: number;
  monthReturnPct: number;
  lines: number;
  trades: number;
  points: number;
  followers: number;
  isFollowed: boolean;
  topHoldings: string[];
}

/**
 * Classement des investisseurs (profils publics), suivi entre membres et profils publics.
 * Le classement est recalculé au plus toutes les 60 s.
 */
export class SocialService {
  private cache: { at: number; entries: LeaderboardEntry[] } | null = null;

  constructor(
    private readonly db: DB,
    private readonly portfolios: PortfolioService,
  ) {}

  leaderboard(viewerId: number | null, period: "month" | "all" = "all", limit = 50): LeaderboardEntry[] {
    if (!this.cache || Date.now() - this.cache.at > 60_000) this.cache = { at: Date.now(), entries: this.compute() };
    const following = viewerId ? new Set((this.db.prepare("SELECT followed_id FROM follows WHERE follower_id = ?").all(viewerId) as { followed_id: number }[]).map((f) => f.followed_id)) : new Set<number>();
    const key = period === "month" ? "monthReturnPct" : "totalReturnPct";
    return [...this.cache.entries]
      .sort((a, b) => b[key] - a[key])
      .slice(0, limit)
      .map((e) => ({ ...e, isFollowed: following.has(e.userId) }));
  }

  private compute(): LeaderboardEntry[] {
    const users = this.db
      .prepare("SELECT id, full_name, role, points FROM users WHERE public_profile = 1 AND role != 'admin'")
      .all() as { id: number; full_name: string; role: string; points: number }[];
    const monthAgo = startOfDayUtc(Date.now()) - 30 * 86_400_000;
    const followers = new Map<number, number>();
    for (const f of this.db.prepare("SELECT followed_id, COUNT(*) AS n FROM follows GROUP BY followed_id").all() as { followed_id: number; n: number }[]) followers.set(f.followed_id, f.n);
    const out: LeaderboardEntry[] = [];
    for (const u of users) {
      let summary;
      try {
        summary = this.portfolios.summary(u.id);
      } catch {
        continue;
      }
      const pf = summary.portfolio;
      const base = this.db
        .prepare("SELECT total_value FROM portfolio_snapshots WHERE portfolio_id = ? AND day <= ? ORDER BY day DESC LIMIT 1")
        .get(pf.id, monthAgo) as { total_value: number } | undefined;
      const monthBase = base?.total_value ?? pf.initialCash;
      const trades = (this.db.prepare("SELECT COUNT(*) AS n FROM trades WHERE user_id = ?").get(u.id) as { n: number }).n;
      out.push({
        userId: u.id,
        displayName: maskName(u.full_name),
        role: u.role,
        totalReturnPct: Math.round(summary.totalPnlPct * 100) / 100,
        monthReturnPct: monthBase ? Math.round((summary.totalValue / monthBase - 1) * 10000) / 100 : 0,
        lines: summary.positions.length,
        trades,
        points: u.points,
        followers: followers.get(u.id) ?? 0,
        isFollowed: false,
        topHoldings: summary.positions.slice(0, 3).map((p) => p.symbol),
      });
    }
    return out;
  }

  follow(followerId: number, followedId: number): void {
    if (followerId === followedId) throw new Error("Impossible de se suivre soi-même");
    const target = this.db.prepare("SELECT public_profile FROM users WHERE id = ?").get(followedId) as { public_profile: number } | undefined;
    if (!target || !target.public_profile) throw new Error("Profil introuvable ou privé");
    this.db.prepare("INSERT OR IGNORE INTO follows(follower_id, followed_id, created_at) VALUES (?,?,?)").run(followerId, followedId, Date.now());
  }

  unfollow(followerId: number, followedId: number): void {
    this.db.prepare("DELETE FROM follows WHERE follower_id = ? AND followed_id = ?").run(followerId, followedId);
  }

  /** Profil public : performance, répartition et dernières opérations (sans montants en FCFA). */
  publicProfile(userId: number, viewerId: number | null) {
    const u = this.db.prepare("SELECT id, full_name, role, points, created_at, public_profile FROM users WHERE id = ?").get(userId) as
      | { id: number; full_name: string; role: string; points: number; created_at: number; public_profile: number }
      | undefined;
    if (!u || (!u.public_profile && viewerId !== userId)) throw new Error("Profil introuvable ou privé");
    const summary = this.portfolios.summary(userId);
    const invested = summary.invested || 1;
    const perf = this.portfolios.performance(userId, 180);
    const trades = this.portfolios.trades(userId, 20).map((t) => ({ symbol: t.symbol, side: t.side, ts: t.ts, resultPct: t.side === "sell" && t.price ? Math.round((t.realizedPnl / (t.price * t.quantity)) * 10000) / 100 : null }));
    const isFollowed = viewerId ? !!this.db.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?").get(viewerId, userId) : false;
    return {
      userId: u.id,
      displayName: maskName(u.full_name),
      role: u.role,
      points: u.points,
      memberSince: u.created_at,
      followers: (this.db.prepare("SELECT COUNT(*) AS n FROM follows WHERE followed_id = ?").get(userId) as { n: number }).n,
      isFollowed,
      totalReturnPct: Math.round(summary.totalPnlPct * 100) / 100,
      allocation: summary.positions.map((p) => ({ symbol: p.symbol, sector: p.sector, weightPct: Math.round((p.marketValue / invested) * 1000) / 10 })),
      cashPct: Math.round((summary.portfolio.cash / (summary.totalValue || 1)) * 100),
      curve: perf.series.map((p) => ({ time: p.time, portfolioPct: p.portfolioPct, benchmarkPct: p.benchmarkPct })),
      stats: perf.stats,
      recentTrades: trades,
    };
  }

  /** Dernières opérations des investisseurs suivis (flux « copier »). */
  followedActivity(userId: number, limit = 30) {
    const rows = this.db
      .prepare(
        `SELECT t.symbol, t.side, t.ts, t.user_id AS userId, u.full_name AS fullName
         FROM trades t JOIN follows f ON f.followed_id = t.user_id JOIN users u ON u.id = t.user_id
         WHERE f.follower_id = ? ORDER BY t.ts DESC LIMIT ?`,
      )
      .all(userId, limit) as { symbol: string; side: "buy" | "sell"; ts: number; userId: number; fullName: string }[];
    return rows.map((r) => ({ ...r, displayName: maskName(r.fullName), fullName: undefined }));
  }
}
