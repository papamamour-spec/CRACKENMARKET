import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { INSTRUMENTS } from "../data/instruments.js";
import { DEFAULT_PARAMS, HORIZON_DAYS, forecast, type Forecast, type Horizon, type ModelParams } from "../engine/forecast.js";
import type { MarketService } from "./market.js";

export interface ForecastLogRow {
  id: number;
  symbol: string;
  horizon: Horizon;
  made_at: number;
  made_day: string;
  price: number;
  expected_pct: number;
  prob_up: number;
  p5: number;
  p95: number;
  ridge_pct: number;
  ar_pct: number;
  news_adj_pct: number;
  params_version: number;
  source: "live" | "backfill";
  realized_pct: number | null;
  hit: number | null;
  abs_err: number | null;
  covered: number | null;
  resolved_at: number | null;
}

export interface LearningStats {
  horizon: Horizon;
  pending: number;
  resolved: number;
  hitRate: number | null;
  maePct: number | null;
  coverage90: number | null;
  brier: number | null;
  naiveHitRate: number | null; // « toujours en hausse »
  naiveMaePct: number | null; // prévision nulle
}

export interface LearningSummary {
  totalResolved: number;
  totalPending: number;
  lastCycleAt: number | null;
  nextCycleAt: number | null;
  backfill: { done: boolean; sessions: number } | null;
  byHorizon: LearningStats[];
  monthly: { month: string; horizon: Horizon; resolved: number; hitRate: number; maePct: number }[];
  recentAdjustments: { symbol: string; horizon: Horizon; version: number; volScale: number; biasPct: number; newsFactor: number; lambda: number; resolved: number; updatedAt: number }[];
}

const LAMBDA_GRID = [1, 5, 20, 60];
const ALPHA = 0.1; // EWMA des erreurs et du biais
const ALPHA_COV = 0.05;

const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/**
 * Apprentissage continu du moteur de prévision.
 *
 * 1. Chaque prévision émise est journalisée (une par jour, valeur et horizon).
 * 2. Quand l'horizon est atteint, elle est résolue avec le cours réellement constaté : direction,
 *    erreur absolue, intervalle tenu, score de Brier.
 * 3. À chaque résolution, les paramètres de la valeur sont recalibrés : erreurs réalisées de chaque
 *    modèle (donc leur pondération), biais, largeur des intervalles (couverture visée 90 %), poids de
 *    l'actualité (renforcé seulement s'il réduit l'erreur).
 * 4. Périodiquement, la régularisation est rechoisie par validation en marche avant.
 * 5. Au premier démarrage, un amorçage rejoue des prévisions « comme à l'époque » sur l'historique
 *    (sans actualité) pour que la boucle dispose immédiatement de prévisions résolues hors échantillon.
 */
export class LearningService extends EventEmitter {
  private paramsCache = new Map<string, ModelParams>();
  private timer: NodeJS.Timeout | null = null;
  private lastCycleAt: number | null = null;
  private nextCycleAt: number | null = null;
  private backfillState: { done: boolean; sessions: number } | null = null;
  private lastTune = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly market: MarketService,
  ) {
    super();
    for (const row of this.db.prepare("SELECT symbol, horizon, params FROM model_params").all() as { symbol: string; horizon: string; params: string }[]) {
      this.paramsCache.set(`${row.symbol}:${row.horizon}`, { ...DEFAULT_PARAMS, ...(JSON.parse(row.params) as ModelParams) });
    }
  }

  params(symbol: string): Record<Horizon, ModelParams> {
    return {
      "1W": this.paramsCache.get(`${symbol}:1W`) ?? DEFAULT_PARAMS,
      "1M": this.paramsCache.get(`${symbol}:1M`) ?? DEFAULT_PARAMS,
      "3M": this.paramsCache.get(`${symbol}:3M`) ?? DEFAULT_PARAMS,
    };
  }

  private save(symbol: string, horizon: Horizon, p: ModelParams): void {
    p.updatedAt = Date.now();
    this.paramsCache.set(`${symbol}:${horizon}`, p);
    this.db.prepare("INSERT OR REPLACE INTO model_params(symbol, horizon, params, updated_at) VALUES (?,?,?,?)").run(symbol, horizon, JSON.stringify(p), p.updatedAt);
  }

  /** Journalise une prévision (ignorée si une prévision du même jour existe déjà). */
  log(f: Forecast, madeAt: number, source: "live" | "backfill" = "live"): number {
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO forecast_log(symbol, horizon, made_at, made_day, price, expected_pct, prob_up, p5, p95, ridge_pct, ar_pct, news_adj_pct, params_version, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    let n = 0;
    for (const h of f.horizons) n += ins.run(f.symbol, h.horizon, madeAt, dayKey(madeAt), f.price, h.expectedReturnPct, h.probUp, h.quantiles.p5, h.quantiles.p95, h.models.ridgePct, h.models.arPct, h.models.newsAdjustmentPct, h.learning.version, source).changes;
    return n;
  }

  /** Résout les prévisions dont l'horizon est atteint et recalibre les paramètres. Retourne le nombre résolu. */
  resolveDue(): number {
    const open = this.db.prepare("SELECT * FROM forecast_log WHERE resolved_at IS NULL ORDER BY made_at").all() as ForecastLogRow[];
    if (!open.length) return 0;
    const bySymbol = new Map<string, ForecastLogRow[]>();
    for (const r of open) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r]);
    const upd = this.db.prepare("UPDATE forecast_log SET realized_pct = ?, hit = ?, abs_err = ?, covered = ?, resolved_at = ? WHERE id = ?");
    let n = 0;
    const tx = this.db.transaction(() => {
      for (const [symbol, rows] of bySymbol) {
        const candles = this.market.history(symbol, 2000);
        for (const r of rows) {
          // bougie de référence = dernière bougie dont la date ≤ made_at ; résolution h séances plus tard
          let i = candles.length - 1;
          while (i >= 0 && candles[i].ts > r.made_at) i--;
          const h = HORIZON_DAYS[r.horizon];
          if (i < 0 || i + h >= candles.length) continue;
          const realized = ((candles[i + h].close - r.price) / r.price) * 100;
          const hit = Math.sign(realized) === Math.sign(r.expected_pct) && r.expected_pct !== 0 ? 1 : 0;
          const absErr = Math.abs(realized - r.expected_pct);
          const covered = realized >= r.p5 && realized <= r.p95 ? 1 : 0;
          upd.run(realized, hit, absErr, covered, Date.now(), r.id);
          this.update(symbol, r.horizon, r, realized, hit, absErr, covered);
          n++;
        }
      }
    });
    tx();
    if (n) this.emit("resolved", n);
    return n;
  }

  /** Mise à jour en ligne des paramètres d'une valeur / horizon à partir d'une prévision résolue. */
  private update(symbol: string, horizon: Horizon, r: ForecastLogRow, realized: number, hit: number, absErr: number, covered: number): void {
    const p: ModelParams = { ...(this.paramsCache.get(`${symbol}:${horizon}`) ?? DEFAULT_PARAMS), modelErr: { ...(this.paramsCache.get(`${symbol}:${horizon}`)?.modelErr ?? DEFAULT_PARAMS.modelErr) } };
    const ew = (prev: number | null, x: number) => (prev == null ? x : prev + ALPHA * (x - prev));
    p.modelErr.ridge = ew(p.modelErr.ridge, Math.abs(realized - r.ridge_pct));
    p.modelErr.ar = ew(p.modelErr.ar, Math.abs(realized - r.ar_pct));
    // biais : EWMA démarrant à 0 (une seule prévision ne doit pas imposer une correction), borné à ±5 points
    p.bias = Math.max(-5, Math.min(5, p.bias + ALPHA * (realized - r.expected_pct - p.bias)));
    // Couverture de l'intervalle 90 % : élargir si elle est insuffisante, resserrer si excessive
    const covRate = p.resolved ? (p.covered + covered) / (p.resolved + 1) : covered;
    const covEw = p.resolved >= 10 ? covRate : null;
    if (covEw != null && p.resolved >= 10) {
      if (covEw < 0.86) p.volScale = Math.min(2, p.volScale * (1 + ALPHA_COV));
      else if (covEw > 0.94) p.volScale = Math.max(0.6, p.volScale * (1 - ALPHA_COV / 2));
    }
    // Actualité : l'ajustement n'est renforcé que s'il a réduit l'erreur
    if (r.news_adj_pct !== 0) {
      const errWithout = Math.abs(realized - (r.expected_pct - r.news_adj_pct));
      p.newsFactor = absErr < errWithout ? Math.min(1.5, p.newsFactor * 1.05) : Math.max(0.1, p.newsFactor * 0.95);
    }
    p.resolved += 1;
    p.hits += hit;
    p.sumAbsErr += absErr;
    p.covered += covered;
    p.sumBrier += (r.prob_up - (realized > 0 ? 1 : 0)) ** 2;
    p.version += 1;
    this.save(symbol, horizon, p);
  }

  /** Rechoix de la régularisation par validation en marche avant (au plus une fois par semaine et par valeur). */
  tuneLambda(symbol: string, force = false): { lambda: number; mae: number } | null {
    const last = this.lastTune.get(symbol) ?? 0;
    if (!force && Date.now() - last < 7 * 86_400_000) return null;
    const candles = this.market.history(symbol, 1400);
    if (candles.length < 200) return null;
    let best: { lambda: number; mae: number } | null = null;
    for (const lambda of LAMBDA_GRID) {
      const params = Object.fromEntries((["1W", "1M", "3M"] as Horizon[]).map((h) => [h, { ...this.params(symbol)[h], lambda }])) as Record<Horizon, ModelParams>;
      const f = forecast({ symbol, candles, params, seed: 1 });
      const mae = f.horizons.reduce((a, h) => a + h.accuracy.maePct / Math.max(0.1, h.accuracy.naiveMaePct), 0) / 3;
      if (!best || mae < best.mae) best = { lambda, mae };
    }
    this.lastTune.set(symbol, Date.now());
    if (best) for (const h of ["1W", "1M", "3M"] as Horizon[]) {
      const p = this.params(symbol)[h];
      if (p.lambda !== best.lambda) this.save(symbol, h, { ...p, lambda: best.lambda, version: p.version + 1 });
    }
    return best;
  }

  /**
   * Amorçage : prévisions rejouées « comme à l'époque » (historique tronqué, sans actualité) toutes les
   * `step` séances sur les `sessions` dernières séances, puis résolues. Exécuté par petits lots en tâche de fond.
   */
  backfill(sessions = Number(process.env.FORECAST_BACKFILL_SESSIONS ?? 120), step = 5, onDone?: () => void): void {
    const already = (this.db.prepare("SELECT COUNT(*) AS n FROM forecast_log WHERE source = 'backfill'").get() as { n: number }).n;
    if (already > 0 || sessions <= 0) {
      this.backfillState = { done: true, sessions: already ? sessions : 0 };
      onDone?.();
      return;
    }
    this.backfillState = { done: false, sessions };
    const jobs: { symbol: string; cut: number }[] = [];
    for (const inst of INSTRUMENTS) {
      const len = this.market.history(inst.symbol, 2000).length;
      for (let back = sessions; back >= HORIZON_DAYS["1W"]; back -= step) jobs.push({ symbol: inst.symbol, cut: len - back });
    }
    const run = () => {
      const job = jobs.shift();
      if (!job) {
        this.resolveDue();
        this.backfillState = { done: true, sessions };
        this.emit("backfill");
        onDone?.();
        return;
      }
      try {
        const candles = this.market.history(job.symbol, 2000).slice(0, job.cut);
        if (candles.length >= 200) {
          const f = forecast({ symbol: job.symbol, candles, params: this.params(job.symbol), seed: job.cut });
          this.log(f, candles[candles.length - 1].ts, "backfill");
        }
      } catch (e) {
        console.warn(`[learning] amorçage ${job.symbol}: ${(e as Error).message}`);
      }
      // résolution et recalibrage au fil de l'eau pour que les prévisions suivantes profitent déjà des réglages
      if (jobs.length % 50 === 0) this.resolveDue();
      setTimeout(run, 20);
    };
    setTimeout(run, 500);
  }

  /** Cycle complet : résolution, recalibrage, rechoix de λ pour les valeurs ayant assez de prévisions. */
  runCycle(): { resolved: number; tuned: number } {
    const resolved = this.resolveDue();
    let tuned = 0;
    for (const inst of INSTRUMENTS) {
      const p = this.params(inst.symbol)["1M"];
      if (p.resolved >= 20 && this.tuneLambda(inst.symbol)) tuned++;
    }
    this.lastCycleAt = Date.now();
    this.emit("cycle", { resolved, tuned });
    return { resolved, tuned };
  }

  start(intervalMs = 6 * 3600_000): void {
    this.backfill(undefined, undefined, () => {
      this.runCycle();
      this.nextCycleAt = Date.now() + intervalMs;
    });
    this.timer = setInterval(() => {
      this.runCycle();
      this.nextCycleAt = Date.now() + intervalMs;
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  summary(): LearningSummary {
    const byHorizon: LearningStats[] = (["1W", "1M", "3M"] as Horizon[]).map((h) => {
      const r = this.db
        .prepare(
          `SELECT COUNT(*) AS resolved, AVG(hit) AS hit, AVG(abs_err) AS mae, AVG(covered) AS cov,
                  AVG((prob_up - (realized_pct > 0)) * (prob_up - (realized_pct > 0))) AS brier,
                  AVG(realized_pct > 0) AS naive_hit, AVG(ABS(realized_pct)) AS naive_mae
           FROM forecast_log WHERE horizon = ? AND resolved_at IS NOT NULL`,
        )
        .get(h) as { resolved: number; hit: number | null; mae: number | null; cov: number | null; brier: number | null; naive_hit: number | null; naive_mae: number | null };
      const pending = (this.db.prepare("SELECT COUNT(*) AS n FROM forecast_log WHERE horizon = ? AND resolved_at IS NULL").get(h) as { n: number }).n;
      const r2 = (v: number | null, k = 100) => (v == null ? null : Math.round(v * k) / k);
      return { horizon: h, pending, resolved: r.resolved, hitRate: r2(r.hit), maePct: r2(r.mae, 10), coverage90: r2(r.cov), brier: r2(r.brier, 1000), naiveHitRate: r2(r.naive_hit), naiveMaePct: r2(r.naive_mae, 10) };
    });
    const monthly = (
      this.db
        .prepare(
          `SELECT substr(made_day, 1, 7) AS month, horizon, COUNT(*) AS resolved, AVG(hit) AS hit, AVG(abs_err) AS mae
           FROM forecast_log WHERE resolved_at IS NOT NULL GROUP BY month, horizon ORDER BY month`,
        )
        .all() as { month: string; horizon: Horizon; resolved: number; hit: number; mae: number }[]
    ).map((m) => ({ month: m.month, horizon: m.horizon, resolved: m.resolved, hitRate: Math.round(m.hit * 100) / 100, maePct: Math.round(m.mae * 10) / 10 }));
    const recentAdjustments = [...this.paramsCache.entries()]
      .map(([k, p]) => {
        const [symbol, horizon] = k.split(":") as [string, Horizon];
        return { symbol, horizon, version: p.version, volScale: Math.round(p.volScale * 100) / 100, biasPct: Math.round(p.bias * 10) / 10, newsFactor: Math.round(p.newsFactor * 100) / 100, lambda: p.lambda, resolved: p.resolved, updatedAt: p.updatedAt };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 12);
    return {
      totalResolved: byHorizon.reduce((a, h) => a + h.resolved, 0),
      totalPending: byHorizon.reduce((a, h) => a + h.pending, 0),
      lastCycleAt: this.lastCycleAt,
      nextCycleAt: this.nextCycleAt,
      backfill: this.backfillState,
      byHorizon,
      monthly,
      recentAdjustments,
    };
  }

  /** Journal d'une valeur (prévisions récentes, résolues ou en attente). */
  journal(symbol: string, limit = 30): ForecastLogRow[] {
    return this.db.prepare("SELECT * FROM forecast_log WHERE symbol = ? ORDER BY made_at DESC LIMIT ?").all(symbol, limit) as ForecastLogRow[];
  }
}
