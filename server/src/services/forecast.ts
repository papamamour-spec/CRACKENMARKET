import { EventEmitter } from "node:events";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../data/instruments.js";
import { forecast, type Forecast, type Horizon } from "../engine/forecast.js";
import type { AdvisorService } from "./advisor.js";
import type { MarketService } from "./market.js";
import type { LearningService } from "./learning.js";

const TTL_MS = 15 * 60_000;

export interface ForecastSummary {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  dailyVolPct: number;
  generatedAt: number;
  horizons: Record<Horizon, { expectedReturnPct: number; probUp: number; hitRate: number; baselineHitRate: number; confidence: number; p5: number; p95: number; liveHitRate: number | null; resolved: number }>;
  summary: string;
  topExplanation: string | null;
}

/**
 * Service de prévision : calcule et met en cache les prévisions probabilistes de chaque valeur
 * (moteur `engine/forecast`), les réchauffe en tâche de fond au démarrage et expose un classement.
 */
export class ForecastService extends EventEmitter {
  private cache = new Map<string, { at: number; f: Forecast }>();
  private warmTimer: NodeJS.Timeout | null = null;
  private learning: LearningService | null = null;

  constructor(
    private readonly market: MarketService,
    private readonly advisor: AdvisorService,
  ) {
    super();
  }

  /** Branche l'apprentissage continu : paramètres appris, journalisation, invalidation du cache après recalibrage. */
  attachLearning(l: LearningService): void {
    this.learning = l;
    // après un recalibrage, les prévisions en cache restent consultables mais sont marquées périmées
    const stale = () => { for (const e of this.cache.values()) e.at = 0; };
    l.on("resolved", stale);
    l.on("backfill", stale);
  }

  /** Réchauffe progressivement le cache (une valeur à la fois pour ne pas bloquer l'API). */
  start(): void {
    const queue = INSTRUMENTS.map((i) => i.symbol);
    const step = () => {
      const sym = queue.shift();
      if (!sym) {
        this.warmTimer = setTimeout(() => { queue.push(...INSTRUMENTS.map((i) => i.symbol)); step(); }, TTL_MS);
        return;
      }
      try { this.get(sym); } catch (e) { console.warn(`[forecast] ${sym}: ${(e as Error).message}`); }
      this.warmTimer = setTimeout(step, 150);
    };
    this.warmTimer = setTimeout(step, 2000);
  }

  stop(): void {
    if (this.warmTimer) clearTimeout(this.warmTimer);
  }

  get(symbol: string): Forecast {
    const inst = INSTRUMENT_MAP.get(symbol);
    if (!inst) throw new Error("Valeur inconnue");
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.f;
    const candles = this.market.history(symbol, 1400);
    const idx = this.market.indexHistory(1400);
    const idxByTs = new Map(idx.map((p) => [p.ts, p.composite]));
    const indexCloses = candles.map((c) => idxByTs.get(c.ts) ?? NaN);
    const aligned = indexCloses.every((v) => Number.isFinite(v)) ? indexCloses : null;
    const news = this.advisor.newsContext().get(symbol);
    const f = forecast({ symbol, candles, indexCloses: aligned, news: news ? { score: news.score, count: news.count } : undefined, params: this.learning?.params(symbol) });
    this.cache.set(symbol, { at: Date.now(), f });
    if (this.learning && candles.length) this.learning.log(f, candles[candles.length - 1].ts, "live");
    return f;
  }

  /** Prévision déjà calculée, sans déclencher de calcul. */
  peek(symbol: string): Forecast | null {
    return this.cache.get(symbol)?.f ?? null;
  }

  summarize(f: Forecast): ForecastSummary {
    const inst = INSTRUMENT_MAP.get(f.symbol)!;
    const horizons = Object.fromEntries(
      f.horizons.map((h) => [h.horizon, { expectedReturnPct: h.expectedReturnPct, probUp: h.probUp, hitRate: h.accuracy.hitRate, baselineHitRate: h.accuracy.baselineHitRate, confidence: h.confidence, p5: h.quantiles.p5, p95: h.quantiles.p95, liveHitRate: h.learning.liveHitRate, resolved: h.learning.resolved }]),
    ) as ForecastSummary["horizons"];
    const m = f.horizons[1];
    return { symbol: f.symbol, name: inst.name, sector: inst.sector, price: f.price, dailyVolPct: f.dailyVolPct, generatedAt: f.generatedAt, horizons, summary: f.summary, topExplanation: m.explanations[0] ?? null };
  }

  /** Classement de toutes les valeurs déjà prévues (le cache se remplit en tâche de fond). */
  ranking(horizon: Horizon = "1M"): { items: ForecastSummary[]; ready: number; total: number; horizon: Horizon } {
    const items = INSTRUMENTS.map((i) => this.peek(i.symbol)).filter((f): f is Forecast => !!f).map((f) => this.summarize(f));
    items.sort((a, b) => b.horizons[horizon].expectedReturnPct * b.horizons[horizon].confidence - a.horizons[horizon].expectedReturnPct * a.horizons[horizon].confidence);
    return { items, ready: items.length, total: INSTRUMENTS.length, horizon };
  }

  /** Calcule toutes les valeurs (synchrone ; utilisé par le conseil pour disposer d'un univers complet). */
  all(): Map<string, Forecast> {
    return new Map(INSTRUMENTS.map((i) => [i.symbol, this.get(i.symbol)]));
  }
}
