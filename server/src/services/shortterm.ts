/**
 * Moteur court terme (étape 2) : méta-étiquetage, Kelly fractionnaire, triple barrière.
 *
 * - Entraînement en marche avant (tâche de fond, comme l'évaluation) : à chaque date, chaque valeur
 *   est prévue avec son seul passé ; quand le primaire attend une hausse à 1 mois, on relève le
 *   contexte (engine/metalabel.ts) et l'issue de la triple barrière sur les clôtures suivantes.
 *   Le modèle secondaire (logistique) est conservé en base avec ses statistiques de test.
 * - Candidats du jour : probabilité apprise pour chaque valeur, barrières selon la volatilité, fraction
 *   de Kelly au quart, panier concentré (5 à 8 lignes) borné par la liquidité et le poids maximal.
 * - Portefeuille court terme publié : positions figées au cours du jour, frais déduits, barrières posées
 *   (objectif, seuil, échéance) ; revue après chaque clôture : la première barrière touchée clôture la
 *   ligne au cours de clôture, frais de sortie déduits. Valorisation quotidienne contre l'indice.
 */
import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../data/instruments.js";
import { forecast, type Forecast } from "../engine/forecast.js";
import { evaluationDates, panelAt, panelInputFor, type EvaluationConfig } from "../engine/evaluation.js";
import { residualMomentum } from "../engine/events.js";
import type { ExtrasAt } from "../engine/panel.js";
import { barriersFor, buildBasket, metaFeatures, predictLogistic, trainMetaModel, tripleBarrier, type BarrierReason, type BarrierSpec, type BasketLine, type LogisticModel, type MetaObservation, type MetaStats } from "../engine/metalabel.js";
import { feeSchedule, liquidityCap, oneWayCostRate, roundTripCostRate, tradeCost } from "../engine/costs.js";
import { isTradingDay } from "../data/providers/simulation.js";
import type { Candle } from "../engine/indicators.js";
import type { MarketService } from "./market.js";
import type { ForecastService } from "./forecast.js";

export interface ShortTermConfig {
  sessions: number;
  step: number;
  minHistory: number;
  /** horizon de référence des barrières (séances) */
  horizon: number;
  kProfit: number;
  kStop: number;
  panel: boolean;
  seed: number;
  lambda: number;
  minProb: number;
  maxLines: number;
  maxWeightPct: number;
  fraction: number;
}

export const DEFAULT_SHORT_TERM: ShortTermConfig = { sessions: 600, step: 10, minHistory: 250, horizon: 21, kProfit: 1.5, kStop: 1.0, panel: true, seed: 11, lambda: 2, minProb: 0.55, maxLines: 8, maxWeightPct: 20, fraction: 0.25 };

export interface StoredMetaModel { id: number; createdAt: number; config: ShortTermConfig; model: LogisticModel; stats: MetaStats }

export interface Candidate {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  expectedPct: number;
  probUp: number;
  prob: number;
  barriers: BarrierSpec;
  targetPrice: number;
  stopPrice: number;
  deadlineTs: number;
  liquidityCapPct: number;
  kelly: number;
  weightPct: number;
  selected: boolean;
}

export interface Position {
  id: number;
  symbol: string;
  name: string;
  entryTs: number;
  entryPrice: number;
  quantity: number;
  weightPct: number;
  prob: number;
  kelly: number;
  targetPrice: number;
  stopPrice: number;
  deadlineTs: number;
  exitTs: number | null;
  exitPrice: number | null;
  exitReason: BarrierReason | "manuel" | null;
  /** cours actuel (ou de sortie), rendement de la ligne (%), distance aux barrières (%) */
  price: number;
  returnPct: number;
  toTargetPct: number;
  toStopPct: number;
  daysLeft: number;
}

export interface ShortTermPortfolio {
  id: number;
  createdAt: number;
  startTs: number;
  capital: number;
  cash: number;
  entryCost: number;
  status: "actif" | "clos";
  closedAt: number | null;
  note: string | null;
  modelId: number | null;
  positions: Position[];
  stats: { value: number; valueNet: number; returnPct: number; returnNetPct: number; compositePct: number; alphaPct: number; open: number; closed: number; wins: number; losses: number; days: number; sessions: number; maxDrawdownPct: number };
  series: { time: number; value: number; portfolioPct: number; benchmarkPct: number }[];
}

export interface ShortTermStatus {
  model: { id: number; createdAt: number; stats: MetaStats; config: ShortTermConfig } | null;
  training: { startedAt: number; done: number; total: number } | null;
  lastReview: number | null;
  active: number;
}

const DAY = 86_400_000;
const r0 = (v: number) => Math.round(v);
const r2 = (v: number) => Math.round(v * 100) / 100;

export class ShortTermService extends EventEmitter {
  private extrasAt: ExtrasAt | undefined;
  private training: ShortTermStatus["training"] = null;
  private timer: NodeJS.Timeout | null = null;
  private lastReview: number | null = null;
  private lastReviewDay = -1;
  private candidateCache: { at: number; items: Candidate[]; cashPct: number; modelId: number | null } | null = null;

  constructor(private readonly db: DB, private readonly market: MarketService, private readonly forecasts: ForecastService) {
    super();
  }

  attach(extrasAt: ExtrasAt | undefined): void {
    this.extrasAt = extrasAt;
  }

  /** Revue des barrières chaque jour ouvré après la clôture (et au démarrage) ; entraînement hebdomadaire si le modèle a plus de 7 jours. SHORTTERM_AUTO=0 désactive. */
  start(): void {
    if (process.env.SHORTTERM_AUTO === "0") return;
    setTimeout(() => { this.review(); if (!this.latestModel() || Date.now() - this.latestModel()!.createdAt > 7 * DAY) this.train(); }, 180_000);
    setInterval(() => {
      const now = new Date();
      const day = Math.floor(now.getTime() / DAY);
      if (isTradingDay(now) && now.getUTCHours() >= 16 && this.lastReviewDay !== day) {
        this.lastReviewDay = day;
        this.review();
        const m = this.latestModel();
        if (!m || Date.now() - m.createdAt > 7 * DAY) this.train();
      }
    }, 10 * 60_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.training = null;
  }

  // ---------- modèle secondaire ----------

  private universe(): { candlesBySymbol: Map<string, Candle[]>; indexByTs: Map<number, number> } {
    const candlesBySymbol = new Map<string, Candle[]>();
    for (const inst of INSTRUMENTS) {
      const c = this.market.history(inst.symbol, 5000);
      if (c.length) candlesBySymbol.set(inst.symbol, c);
    }
    return { candlesBySymbol, indexByTs: new Map(this.market.indexHistory(5000).map((p) => [p.ts, p.composite])) };
  }

  /** Observation (contexte + issue de la triple barrière) d'une valeur à une date, sans lire le futur pour le contexte. */
  private observe(symbol: string, candles: Candle[], indexByTs: Map<number, number>, ts: number, cfg: ShortTermConfig, panel: ReturnType<typeof panelAt>, roundTrip: number): MetaObservation | null {
    let cut = candles.length - 1;
    while (cut >= 0 && candles[cut].ts > ts) cut--;
    if (cut + 1 < cfg.minHistory) return null;
    const past = candles.slice(0, cut + 1);
    const idx = past.map((c) => indexByTs.get(c.ts) ?? null);
    const aligned = idx.every((v) => v != null) ? (idx as number[]) : null;
    const f = forecast({ symbol, candles: past, indexCloses: aligned, seed: cfg.seed, panel: panelInputFor(panel, symbol) });
    const h = f.horizons[1];
    if (!(h.expectedReturnPct > 0)) return null; // le primaire ne dit pas d'acheter : pas de position à étiqueter
    const spec = barriersFor(f.dailyVolPct / 100 / Math.sqrt(252), cfg.horizon, cfg.kProfit, cfg.kStop);
    const out = tripleBarrier(candles.map((c) => c.close), cut, spec);
    if (!out) return null;
    const x = this.features(f, past, idx, ts);
    return { ts, symbol, x, y: out.ret > roundTrip ? 1 : 0, retPct: r2((out.ret - roundTrip) * 100), reason: out.reason };
  }

  private features(f: Forecast, past: Candle[], idx: (number | null)[] | null, ts: number): number[] {
    const h = f.horizons[1];
    const price = past[past.length - 1].close;
    const ex = this.extrasAt?.(f.symbol, ts, price);
    return metaFeatures({
      expectedPct: h.expectedReturnPct,
      probUp: h.probUp,
      confidence: h.confidence,
      hitRate: h.accuracy.hitRate,
      baselineHitRate: h.accuracy.baselineHitRate,
      dailyVolPct: f.dailyVolPct,
      closes: past.map((c) => c.close),
      volumes: past.map((c) => c.volume),
      index: idx,
      month: new Date(ts).getUTCMonth(),
      signals: { pubDrift: ex?.pubDrift ?? 0, divWindow: ex?.divWindow ?? 0, book5: ex?.book5 ?? 0, resMom: residualMomentum(past.map((c) => c.close), idx, past.length - 1) },
    });
  }

  /** Entraînement synchrone (tests, script). */
  trainSync(partial: Partial<ShortTermConfig> = {}, onProgress?: (done: number, total: number) => void): StoredMetaModel {
    const cfg = { ...DEFAULT_SHORT_TERM, ...partial };
    const u = this.universe();
    const evalCfg: EvaluationConfig = { sessions: cfg.sessions, step: cfg.step, topK: 5, feePct: 1.25, minHistory: cfg.minHistory, horizons: ["1M"], seed: cfg.seed, panel: cfg.panel };
    const dates = evaluationDates(u.candlesBySymbol, evalCfg).filter((ts) => {
      // il faut assez de futur pour connaître l'issue (2 h séances) : on ignore les dernières dates
      const tl = [...u.indexByTs.keys()].sort((a, b) => a - b);
      return tl.indexOf(ts) >= 0 && tl.indexOf(ts) + 2 * cfg.horizon < tl.length;
    });
    const obs: MetaObservation[] = [];
    const roundTrip = roundTripCostRate(feeSchedule());
    let done = 0;
    for (const ts of dates) {
      const panel = panelAt(u.candlesBySymbol, ts, evalCfg, this.extrasAt);
      for (const [symbol, candles] of u.candlesBySymbol) {
        const o = this.observe(symbol, candles, u.indexByTs, ts, cfg, panel, roundTrip);
        if (o) obs.push(o);
      }
      onProgress?.(++done, dates.length);
    }
    return this.store(cfg, obs);
  }

  private store(cfg: ShortTermConfig, obs: MetaObservation[]): StoredMetaModel {
    const { model, stats } = trainMetaModel(obs, cfg.lambda, cfg.minProb);
    const createdAt = Date.now();
    const id = Number(this.db.prepare("INSERT INTO meta_models(created_at, config, model, stats) VALUES (?,?,?,?)").run(createdAt, JSON.stringify(cfg), JSON.stringify(model), JSON.stringify(stats)).lastInsertRowid);
    this.candidateCache = null;
    const stored = { id, createdAt, config: cfg, model, stats };
    this.emit("model", stored);
    return stored;
  }

  /** Entraînement en tâche de fond, découpé par dates ; false si déjà en cours. */
  train(partial: Partial<ShortTermConfig> = {}): boolean {
    if (this.training) return false;
    const cfg = { ...DEFAULT_SHORT_TERM, ...partial };
    const u = this.universe();
    const evalCfg: EvaluationConfig = { sessions: cfg.sessions, step: cfg.step, topK: 5, feePct: 1.25, minHistory: cfg.minHistory, horizons: ["1M"], seed: cfg.seed, panel: cfg.panel };
    const tl = [...u.indexByTs.keys()].sort((a, b) => a - b);
    const dates = evaluationDates(u.candlesBySymbol, evalCfg).filter((ts) => tl.indexOf(ts) >= 0 && tl.indexOf(ts) + 2 * cfg.horizon < tl.length);
    if (!dates.length) return false;
    this.training = { startedAt: Date.now(), done: 0, total: dates.length };
    const obs: MetaObservation[] = [];
    const roundTrip = roundTripCostRate(feeSchedule());
    const queue = [...dates];
    const step = () => {
      const ts = queue.shift();
      if (ts == null) {
        try {
          this.store(cfg, obs);
        } catch (e) {
          console.warn(`[court-terme] entraînement : ${(e as Error).message}`);
        }
        this.training = null;
        this.timer = null;
        return;
      }
      try {
        const panel = panelAt(u.candlesBySymbol, ts, evalCfg, this.extrasAt);
        for (const [symbol, candles] of u.candlesBySymbol) {
          const o = this.observe(symbol, candles, u.indexByTs, ts, cfg, panel, roundTrip);
          if (o) obs.push(o);
        }
      } catch (e) {
        console.warn(`[court-terme] date ${new Date(ts).toISOString().slice(0, 10)} : ${(e as Error).message}`);
      }
      this.training!.done++;
      this.timer = setTimeout(step, 30);
    };
    this.timer = setTimeout(step, 10);
    return true;
  }

  latestModel(): StoredMetaModel | null {
    const r = this.db.prepare("SELECT * FROM meta_models ORDER BY id DESC LIMIT 1").get() as { id: number; created_at: number; config: string; model: string; stats: string } | undefined;
    return r ? { id: r.id, createdAt: r.created_at, config: JSON.parse(r.config) as ShortTermConfig, model: JSON.parse(r.model) as LogisticModel, stats: JSON.parse(r.stats) as MetaStats } : null;
  }

  // ---------- candidats du jour ----------

  /** Probabilité apprise, barrières et poids de Kelly pour chaque valeur ; panier sélectionné. */
  candidates(capital = 10_000_000): { items: Candidate[]; cashPct: number; modelId: number | null; at: number } {
    if (this.candidateCache && Date.now() - this.candidateCache.at < 30 * 60_000) return { ...this.candidateCache };
    const m = this.latestModel();
    const cfg = m?.config ?? DEFAULT_SHORT_TERM;
    const idxAll = new Map(this.market.indexHistory(1400).map((p) => [p.ts, p.composite]));
    const roundTrip = roundTripCostRate(feeSchedule());
    const now = Date.now();
    const raw: { c: Omit<Candidate, "kelly" | "weightPct" | "selected">; f: Forecast }[] = [];
    for (const inst of INSTRUMENTS) {
      let f: Forecast;
      try { f = this.forecasts.get(inst.symbol); } catch { continue; }
      const candles = this.market.history(inst.symbol, 1400);
      if (candles.length < 70) continue;
      const idx = candles.map((c) => idxAll.get(c.ts) ?? null);
      const h = f.horizons[1];
      const spec = barriersFor(f.dailyVolPct / 100 / Math.sqrt(252), cfg.horizon, cfg.kProfit, cfg.kStop);
      const x = this.features(f, candles, idx.every((v) => v != null) ? idx : null, candles[candles.length - 1].ts);
      const prob = m ? predictLogistic(m.model, x) : h.probUp;
      const price = f.price;
      raw.push({ f, c: { symbol: inst.symbol, name: inst.name, sector: inst.sector, price, expectedPct: h.expectedReturnPct, probUp: h.probUp, prob: r2(prob), barriers: spec, targetPrice: r0(price * (1 + spec.profit)), stopPrice: r0(price * (1 - spec.stop)), deadlineTs: now + Math.ceil((spec.maxSessions * 7) / 5) * DAY, liquidityCapPct: r2(liquidityCap(capital, inst.avgVolume * price) * 100) } });
    }
    const basket = buildBasket(raw.map((r) => ({ symbol: r.c.symbol, price: r.c.price, prob: r.c.prob, expectedPct: r.c.expectedPct, barriers: r.c.barriers, liquidityCap: r.c.liquidityCapPct / 100 })), { maxLines: cfg.maxLines, minProb: cfg.minProb, maxWeightPct: cfg.maxWeightPct, fraction: cfg.fraction, roundTripCost: roundTrip });
    const byLine = new Map(basket.lines.map((l) => [l.symbol, l]));
    const items: Candidate[] = raw
      .map((r) => { const l = byLine.get(r.c.symbol); return { ...r.c, kelly: l?.kelly ?? 0, weightPct: l?.weightPct ?? 0, selected: !!l }; })
      .sort((a, b) => Number(b.selected) - Number(a.selected) || b.weightPct - a.weightPct || b.prob - a.prob);
    this.candidateCache = { at: now, items, cashPct: basket.cashPct, modelId: m?.id ?? null };
    return { ...this.candidateCache };
  }

  invalidate(): void {
    this.candidateCache = null;
  }

  // ---------- portefeuille court terme ----------

  /** Fige le panier du jour au cours du jour, frais d'entrée déduits, barrières posées. */
  publish(userId: number, capital: number, note: string | null = null): ShortTermPortfolio {
    if (!(capital > 0)) throw new Error("Capital invalide");
    const { items, modelId } = this.candidates(capital);
    const lines = items.filter((c) => c.selected);
    if (!lines.length) throw new Error("Aucun candidat ne dépasse le seuil de probabilité : pas de panier à publier");
    const fees = feeSchedule();
    const now = Date.now();
    const today = Math.floor(now / DAY) * DAY;
    const startTs = Math.min(today, this.market.indexHistory(1)[0]?.ts ?? today);
    let entryCost = 0;
    let invested = 0;
    const rows: { l: Candidate; quantity: number; amount: number }[] = [];
    for (const l of lines) {
      const quantity = Math.floor((capital * l.weightPct) / 100 / l.price);
      if (quantity <= 0) continue;
      const amount = quantity * l.price;
      entryCost += tradeCost(amount, fees);
      invested += amount;
      rows.push({ l, quantity, amount });
    }
    if (!rows.length) throw new Error("Capital trop faible pour une seule action");
    const cash = r0(capital - invested - entryCost);
    if (cash < 0) throw new Error("Les frais d'entrée dépassent les liquidités restantes");
    const id = Number(this.db.prepare("INSERT INTO st_portfolios(user_id, created_at, start_ts, capital, cash, entry_cost, status, note, model_id) VALUES (?,?,?,?,?,?,'actif',?,?)").run(userId, now, startTs, capital, cash, r0(entryCost), note, modelId).lastInsertRowid);
    const ins = this.db.prepare("INSERT INTO st_positions(portfolio_id, symbol, entry_ts, entry_price, quantity, weight_pct, prob, kelly, target_price, stop_price, deadline_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    for (const r of rows) ins.run(id, r.l.symbol, startTs, r.l.price, r.quantity, r2((r.amount / capital) * 100), r.l.prob, r.l.kelly, r.l.targetPrice, r.l.stopPrice, startTs + (r.l.deadlineTs - now));
    this.emit("published", id);
    return this.view(userId, id)!;
  }

  /** Revue des barrières de tous les portefeuilles actifs sur les clôtures postérieures à l'entrée. */
  review(): { reviewed: number; closed: number } {
    const fees = feeSchedule();
    const ports = this.db.prepare("SELECT id, cash FROM st_portfolios WHERE status = 'actif'").all() as { id: number; cash: number }[];
    let closed = 0;
    for (const p of ports) {
      const open = this.db.prepare("SELECT * FROM st_positions WHERE portfolio_id = ? AND exit_ts IS NULL").all(p.id) as PositionRow[];
      let cash = p.cash;
      for (const pos of open) {
        const hist = this.market.history(pos.symbol, 400).filter((c) => c.ts > pos.entry_ts);
        for (const c of hist) {
          const reason: BarrierReason | null = c.close >= pos.target_price ? "objectif" : c.close <= pos.stop_price ? "seuil" : c.ts >= pos.deadline_ts ? "échéance" : null;
          if (!reason) continue;
          const amount = pos.quantity * c.close;
          const cost = tradeCost(amount, fees);
          this.db.prepare("UPDATE st_positions SET exit_ts = ?, exit_price = ?, exit_reason = ?, exit_cost = ? WHERE id = ?").run(c.ts, c.close, reason, r0(cost), pos.id);
          cash += amount - cost;
          closed++;
          break;
        }
      }
      if (cash !== p.cash) this.db.prepare("UPDATE st_portfolios SET cash = ? WHERE id = ?").run(r0(cash), p.id);
      const remaining = (this.db.prepare("SELECT COUNT(*) AS n FROM st_positions WHERE portfolio_id = ? AND exit_ts IS NULL").get(p.id) as { n: number }).n;
      if (remaining === 0) this.db.prepare("UPDATE st_portfolios SET status = 'clos', closed_at = ? WHERE id = ?").run(Date.now(), p.id);
    }
    this.lastReview = Date.now();
    if (closed) this.emit("review", closed);
    return { reviewed: ports.length, closed };
  }

  /** Clôture manuelle d'une position (au dernier cours) ou de tout le portefeuille. */
  close(userId: number, portfolioId: number, positionId: number | null = null): ShortTermPortfolio | null {
    const p = this.db.prepare("SELECT * FROM st_portfolios WHERE id = ? AND user_id = ?").get(portfolioId, userId) as PortfolioRow | undefined;
    if (!p) return null;
    const fees = feeSchedule();
    const open = (this.db.prepare("SELECT * FROM st_positions WHERE portfolio_id = ? AND exit_ts IS NULL").all(portfolioId) as PositionRow[]).filter((x) => positionId == null || x.id === positionId);
    let cash = p.cash;
    const now = Date.now();
    for (const pos of open) {
      const price = this.market.price(pos.symbol) || pos.entry_price;
      const amount = pos.quantity * price;
      const cost = tradeCost(amount, fees);
      this.db.prepare("UPDATE st_positions SET exit_ts = ?, exit_price = ?, exit_reason = 'manuel', exit_cost = ? WHERE id = ?").run(now, price, r0(cost), pos.id);
      cash += amount - cost;
    }
    this.db.prepare("UPDATE st_portfolios SET cash = ? WHERE id = ?").run(r0(cash), portfolioId);
    const remaining = (this.db.prepare("SELECT COUNT(*) AS n FROM st_positions WHERE portfolio_id = ? AND exit_ts IS NULL").get(portfolioId) as { n: number }).n;
    if (remaining === 0) this.db.prepare("UPDATE st_portfolios SET status = 'clos', closed_at = ? WHERE id = ?").run(now, portfolioId);
    return this.view(userId, portfolioId);
  }

  list(userId: number): Omit<ShortTermPortfolio, "positions" | "series">[] {
    const rows = this.db.prepare("SELECT * FROM st_portfolios WHERE user_id = ? ORDER BY created_at DESC").all(userId) as PortfolioRow[];
    return rows.map((r) => { const v = this.build(r); const { positions: _p, series: _s, ...rest } = v; return rest; });
  }

  view(userId: number, id: number): ShortTermPortfolio | null {
    const r = this.db.prepare("SELECT * FROM st_portfolios WHERE id = ? AND user_id = ?").get(id, userId) as PortfolioRow | undefined;
    return r ? this.build(r) : null;
  }

  private build(r: PortfolioRow): ShortTermPortfolio {
    const rows = this.db.prepare("SELECT * FROM st_positions WHERE portfolio_id = ? ORDER BY id").all(r.id) as PositionRow[];
    const exit = oneWayCostRate(feeSchedule());
    const now = Date.now();
    // valorisation quotidienne : liquidités (évoluant aux sorties) + positions ouvertes aux clôtures
    const datesSet = new Set<number>();
    const closesBy = new Map<number, Map<number, number>>();
    for (const pos of rows) {
      const hist = this.market.history(pos.symbol, 400).filter((c) => c.ts >= r.start_ts);
      closesBy.set(pos.id, new Map(hist.map((c) => [c.ts, c.close])));
      for (const c of hist) datesSet.add(c.ts);
    }
    const dates = [...datesSet].sort((a, b) => a - b);
    const idx = this.market.indexHistory(400).filter((x) => x.ts >= r.start_ts);
    const idx0 = idx[0];
    const idxByTs = new Map(idx.map((x) => [x.ts, x.composite]));
    const initialCash = r.capital - rows.reduce((a, p) => a + p.quantity * p.entry_price, 0) - r.entry_cost;
    const last = new Map<number, number>();
    let lastIdx = idx0?.composite ?? 0;
    const series: ShortTermPortfolio["series"] = dates.map((ts) => {
      let cash = initialCash;
      let v = 0;
      for (const pos of rows) {
        if (pos.exit_ts != null && pos.exit_ts <= ts) { cash += pos.quantity * pos.exit_price! - (pos.exit_cost ?? 0); continue; }
        const close = closesBy.get(pos.id)!.get(ts) ?? last.get(pos.id) ?? pos.entry_price;
        last.set(pos.id, close);
        v += pos.quantity * close;
      }
      const i = idxByTs.get(ts) ?? lastIdx;
      lastIdx = i;
      const value = cash + v;
      return { time: ts, value: r0(value), portfolioPct: r2((value / r.capital - 1) * 100), benchmarkPct: idx0 ? r2((i / idx0.composite - 1) * 100) : 0 };
    });
    const lastPt = series[series.length - 1];
    const positions: Position[] = rows.map((pos) => {
      const price = pos.exit_price ?? this.market.price(pos.symbol) ?? pos.entry_price;
      return { id: pos.id, symbol: pos.symbol, name: INSTRUMENT_MAP.get(pos.symbol)?.name ?? pos.symbol, entryTs: pos.entry_ts, entryPrice: pos.entry_price, quantity: pos.quantity, weightPct: pos.weight_pct, prob: pos.prob, kelly: pos.kelly, targetPrice: pos.target_price, stopPrice: pos.stop_price, deadlineTs: pos.deadline_ts, exitTs: pos.exit_ts, exitPrice: pos.exit_price, exitReason: (pos.exit_reason as Position["exitReason"]) ?? null, price, returnPct: r2((price / pos.entry_price - 1) * 100), toTargetPct: r2((pos.target_price / price - 1) * 100), toStopPct: r2((pos.stop_price / price - 1) * 100), daysLeft: pos.exit_ts != null ? 0 : Math.max(0, Math.ceil((pos.deadline_ts - now) / DAY)) };
    });
    const openPos = positions.filter((p) => p.exitTs == null);
    const investedNow = openPos.reduce((a, p) => a + p.quantity * p.price, 0);
    const value = lastPt?.value ?? r.cash + investedNow;
    const valueNet = value - investedNow * exit;
    let peak = -Infinity;
    let mdd = 0;
    for (const s of series) { peak = Math.max(peak, s.value); mdd = Math.min(mdd, s.value / peak - 1); }
    const closedPos = positions.filter((p) => p.exitTs != null);
    return {
      id: r.id,
      createdAt: r.created_at,
      startTs: r.start_ts,
      capital: r.capital,
      cash: r.cash,
      entryCost: r.entry_cost,
      status: r.status,
      closedAt: r.closed_at,
      note: r.note,
      modelId: r.model_id,
      positions,
      stats: { value: r0(value), valueNet: r0(valueNet), returnPct: r2((value / r.capital - 1) * 100), returnNetPct: r2((valueNet / r.capital - 1) * 100), compositePct: lastPt?.benchmarkPct ?? 0, alphaPct: r2((valueNet / r.capital - 1) * 100 - (lastPt?.benchmarkPct ?? 0)), open: openPos.length, closed: closedPos.length, wins: closedPos.filter((p) => p.returnPct > 0).length, losses: closedPos.filter((p) => p.returnPct <= 0).length, days: lastPt ? Math.max(0, Math.round((lastPt.time - r.start_ts) / DAY)) : 0, sessions: series.length, maxDrawdownPct: r2(mdd * 100) },
      series,
    };
  }

  status(): ShortTermStatus {
    const m = this.latestModel();
    const active = (this.db.prepare("SELECT COUNT(*) AS n FROM st_portfolios WHERE status = 'actif'").get() as { n: number }).n;
    return { model: m ? { id: m.id, createdAt: m.createdAt, stats: m.stats, config: m.config } : null, training: this.training, lastReview: this.lastReview, active };
  }
}

interface PortfolioRow { id: number; user_id: number; created_at: number; start_ts: number; capital: number; cash: number; entry_cost: number; status: "actif" | "clos"; closed_at: number | null; note: string | null; model_id: number | null }
interface PositionRow { id: number; portfolio_id: number; symbol: string; entry_ts: number; entry_price: number; quantity: number; weight_pct: number; prob: number; kelly: number; target_price: number; stop_price: number; deadline_ts: number; exit_ts: number | null; exit_price: number | null; exit_reason: string | null; exit_cost: number | null }
