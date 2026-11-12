/**
 * Évaluation en marche avant du moteur de prévision.
 *
 * À chaque date d'évaluation (toutes les `step` séances sur les `sessions` dernières), chaque valeur
 * est prévue avec son seul historique antérieur (aucune donnée future, paramètres par défaut,
 * graine fixe : le rapport est reproductible), puis confrontée au rendement réalisé à l'horizon
 * sur la série ajustée (rendement total). Par horizon :
 *  - précision de direction contre la référence « toujours en hausse », erreur absolue contre la
 *    prévision nulle ;
 *  - corrélation de rang (Spearman) entre prévu et réalisé à chaque date, moyenne et statistique t :
 *    c'est la mesure qui compte pour l'optimisation, qui ne demande au modèle que de classer ;
 *  - calibration : couverture réelle de l'intervalle à 90 %, score de Brier de la probabilité de
 *    hausse, table de fiabilité (probabilité annoncée contre fréquence observée) ;
 *  - stratégie simple : les k meilleures valeurs prévues, équipondérées, rebalancées à l'horizon,
 *    nettes de frais de courtage sur la part renouvelée, contre l'indice et le panier équipondéré.
 * Rien ici n'est une garantie : ce sont des mesures passées, calculées sans regarder l'avenir.
 */
import { forecast, HORIZON_DAYS, type Horizon } from "./forecast.js";
import type { Candle } from "./indicators.js";
import { mean, stddev } from "./linalg.js";

export interface EvaluationConfig {
  /** profondeur évaluée (séances) */
  sessions: number;
  /** pas entre deux dates d'évaluation (séances) */
  step: number;
  /** nombre de valeurs retenues par la stratégie */
  topK: number;
  /** frais de courtage par ordre (% du montant), appliqués à l'achat et à la vente */
  feePct: number;
  /** historique minimal pour prévoir une valeur */
  minHistory: number;
  horizons: Horizon[];
  seed: number;
}

export const DEFAULT_EVALUATION: EvaluationConfig = { sessions: 400, step: 10, topK: 5, feePct: 1.25, minHistory: 200, horizons: ["1W", "1M", "3M"], seed: 7 };

export interface Observation {
  ts: number;
  symbol: string;
  horizon: Horizon;
  expectedPct: number;
  probUp: number;
  p5: number;
  p95: number;
  confidence: number;
  realizedPct: number;
}

export interface ReliabilityBin { from: number; to: number; n: number; predicted: number | null; observed: number | null }

export interface StrategyStats {
  periods: number;
  totalReturnPct: number;
  annualizedPct: number | null;
  maxDrawdownPct: number;
  sharpe: number | null;
  winShare: number;
  curve: { ts: number; value: number }[];
}

export interface HorizonEvaluation {
  horizon: Horizon;
  horizonDays: number;
  n: number;
  dates: number;
  hitRate: number;
  baselineHitRate: number;
  maePct: number;
  naiveMaePct: number;
  /** 1 − erreur / erreur naïve : > 0 signifie que le modèle bat la prévision nulle */
  skill: number;
  ic: { mean: number | null; std: number | null; tStat: number | null; positiveShare: number | null; dates: number };
  coverage90: number;
  brier: number;
  baselineBrier: number;
  reliability: ReliabilityBin[];
  strategy: { topK: StrategyStats; index: StrategyStats | null; equalWeight: StrategyStats; costsPct: number };
}

export interface EvaluationReport {
  generatedAt: number;
  config: EvaluationConfig;
  universe: number;
  firstDate: number | null;
  lastDate: number | null;
  horizons: HorizonEvaluation[];
  verdict: string[];
}

const r2 = (v: number, k = 100) => Math.round(v * k) / k;

/** Rangs moyens (ex æquo partagés). */
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k].i] = r;
    i = j + 1;
  }
  return out;
}

/** Corrélation de rang de Spearman (null si moins de 3 couples ou variance nulle). */
export function spearman(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ra = ranks(a);
  const rb = ranks(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

/** Table de fiabilité de la probabilité de hausse. */
export function reliability(obs: { probUp: number; realizedPct: number }[]): ReliabilityBin[] {
  const edges = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0001];
  const bins: ReliabilityBin[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const inBin = obs.filter((o) => o.probUp >= edges[i] && o.probUp < edges[i + 1]);
    bins.push({ from: edges[i], to: Math.min(1, edges[i + 1]), n: inBin.length, predicted: inBin.length ? r2(mean(inBin.map((o) => o.probUp)), 1000) : null, observed: inBin.length ? r2(inBin.filter((o) => o.realizedPct > 0).length / inBin.length, 1000) : null });
  }
  return bins;
}

/** Statistiques d'une suite de rendements par période (%), avec courbe cumulée. */
export function strategyStats(periods: { ts: number; retPct: number }[], sessionsPerPeriod: number): StrategyStats {
  let value = 100;
  let peak = 100;
  let mdd = 0;
  const curve = [{ ts: periods[0]?.ts ?? 0, value: 100 }];
  for (const p of periods) {
    value *= 1 + p.retPct / 100;
    peak = Math.max(peak, value);
    mdd = Math.max(mdd, 1 - value / peak);
    curve.push({ ts: p.ts, value: r2(value) });
  }
  const rets = periods.map((p) => p.retPct);
  const perYear = 261 / Math.max(1, sessionsPerPeriod);
  const sd = rets.length > 1 ? stddev(rets) : 0;
  const totalSessions = periods.length * sessionsPerPeriod;
  return {
    periods: periods.length,
    totalReturnPct: r2(value - 100, 10),
    annualizedPct: totalSessions >= 60 ? r2(((value / 100) ** (261 / totalSessions) - 1) * 100, 10) : null,
    maxDrawdownPct: r2(mdd * 100, 10),
    sharpe: sd > 0 ? r2((mean(rets) / sd) * Math.sqrt(perYear)) : null,
    winShare: rets.length ? r2(rets.filter((r) => r > 0).length / rets.length) : 0,
    curve,
  };
}

/**
 * Agrège des observations (prévu / réalisé) en évaluation par horizon. Séparé du calcul des prévisions
 * pour être testable et pour servir aussi au journal de l'apprentissage continu.
 */
export function evaluateObservations(obs: Observation[], indexReturns: Map<string, number>, config: EvaluationConfig): HorizonEvaluation[] {
  const out: HorizonEvaluation[] = [];
  for (const horizon of config.horizons) {
    const o = obs.filter((x) => x.horizon === horizon);
    const h = HORIZON_DAYS[horizon];
    if (!o.length) continue;
    const byDate = new Map<number, Observation[]>();
    for (const x of o) byDate.set(x.ts, [...(byDate.get(x.ts) ?? []), x]);
    const dates = [...byDate.keys()].sort((a, b) => a - b);
    // corrélation de rang par date
    const ics: number[] = [];
    for (const d of dates) {
      const rows = byDate.get(d)!;
      if (rows.length < 5) continue;
      const ic = spearman(rows.map((x) => x.expectedPct), rows.map((x) => x.realizedPct));
      if (ic != null) ics.push(ic);
    }
    const icMean = ics.length ? mean(ics) : null;
    const icStd = ics.length > 1 ? stddev(ics) : null;
    // stratégie : dates espacées d'au moins h séances (périodes non chevauchantes)
    const every = Math.max(1, Math.ceil(h / config.step));
    const rebalance = dates.filter((_, i) => i % every === 0);
    const fee = config.feePct;
    let prev = new Set<string>();
    const top: { ts: number; retPct: number }[] = [];
    const eq: { ts: number; retPct: number }[] = [];
    const idx: { ts: number; retPct: number }[] = [];
    let costs = 0;
    for (const d of rebalance) {
      const rows = byDate.get(d)!;
      const chosen = [...rows].sort((a, b) => b.expectedPct - a.expectedPct).slice(0, config.topK);
      const names = new Set(chosen.map((c) => c.symbol));
      const kept = [...names].filter((s) => prev.has(s)).length;
      const turnover = names.size ? (names.size - kept) / names.size : 0; // part du panier renouvelée
      const cost = 2 * fee * turnover; // vente de la part sortante + achat de la part entrante
      costs += cost;
      top.push({ ts: d, retPct: mean(chosen.map((c) => c.realizedPct)) - cost });
      eq.push({ ts: d, retPct: mean(rows.map((c) => c.realizedPct)) });
      const ir = indexReturns.get(`${d}:${horizon}`);
      if (ir != null) idx.push({ ts: d, retPct: ir });
      prev = names;
    }
    const sessionsPerPeriod = every * config.step;
    const hits = o.filter((x) => Math.sign(x.expectedPct) === Math.sign(x.realizedPct) && x.expectedPct !== 0).length;
    const mae = mean(o.map((x) => Math.abs(x.expectedPct - x.realizedPct)));
    const naive = mean(o.map((x) => Math.abs(x.realizedPct)));
    const upShare = o.filter((x) => x.realizedPct > 0).length / o.length;
    out.push({
      horizon,
      horizonDays: h,
      n: o.length,
      dates: dates.length,
      hitRate: r2(hits / o.length),
      baselineHitRate: r2(upShare),
      maePct: r2(mae, 10),
      naiveMaePct: r2(naive, 10),
      skill: naive > 0 ? r2(1 - mae / naive, 1000) : 0,
      ic: { mean: icMean != null ? r2(icMean, 1000) : null, std: icStd != null ? r2(icStd, 1000) : null, tStat: icMean != null && icStd != null && icStd > 0 ? r2((icMean / icStd) * Math.sqrt(ics.length)) : null, positiveShare: ics.length ? r2(ics.filter((v) => v > 0).length / ics.length) : null, dates: ics.length },
      coverage90: r2(o.filter((x) => x.realizedPct >= x.p5 && x.realizedPct <= x.p95).length / o.length),
      brier: r2(mean(o.map((x) => (x.probUp - (x.realizedPct > 0 ? 1 : 0)) ** 2)), 1000),
      baselineBrier: r2(mean(o.map((x) => (upShare - (x.realizedPct > 0 ? 1 : 0)) ** 2)), 1000),
      reliability: reliability(o),
      strategy: { topK: strategyStats(top, sessionsPerPeriod), index: idx.length === top.length && idx.length ? strategyStats(idx, sessionsPerPeriod) : null, equalWeight: strategyStats(eq, sessionsPerPeriod), costsPct: r2(costs, 10) },
    });
  }
  return out;
}

export interface EvaluationInput {
  /** historique ajusté par valeur (ordre chronologique) */
  candlesBySymbol: Map<string, Candle[]>;
  /** clôture de l'indice composite par date (ms) */
  indexByTs: Map<number, number>;
  config?: Partial<EvaluationConfig>;
  /** appelé après chaque date évaluée (progression) */
  onProgress?: (done: number, total: number) => void;
}

/** Dates d'évaluation communes et, pour chaque valeur, l'indice de coupe à chaque date. */
export function evaluationDates(candlesBySymbol: Map<string, Candle[]>, config: EvaluationConfig): number[] {
  const all = new Set<number>();
  for (const c of candlesBySymbol.values()) for (const x of c) all.add(x.ts);
  const timeline = [...all].sort((a, b) => a - b);
  const maxH = Math.max(...config.horizons.map((h) => HORIZON_DAYS[h]));
  const last = timeline.length - 1 - maxH;
  const first = Math.max(config.minHistory, timeline.length - 1 - config.sessions);
  const dates: number[] = [];
  for (let i = first; i <= last; i += config.step) dates.push(timeline[i]);
  return dates;
}

/** Observations prévu / réalisé d'une valeur à une date (aucune donnée postérieure à la date n'est lue). */
export function observeAt(symbol: string, candles: Candle[], indexByTs: Map<number, number>, ts: number, config: EvaluationConfig): Observation[] {
  let cut = candles.length - 1;
  while (cut >= 0 && candles[cut].ts > ts) cut--;
  if (cut + 1 < config.minHistory) return [];
  const past = candles.slice(0, cut + 1);
  const idx = past.map((c) => indexByTs.get(c.ts) ?? NaN);
  const f = forecast({ symbol, candles: past, indexCloses: idx.every(Number.isFinite) ? idx : null, seed: config.seed });
  const out: Observation[] = [];
  for (const h of f.horizons) {
    if (!config.horizons.includes(h.horizon)) continue;
    const target = candles[cut + h.horizonDays];
    if (!target) continue;
    const realizedPct = (target.close / past[past.length - 1].close - 1) * 100;
    out.push({ ts, symbol, horizon: h.horizon, expectedPct: h.expectedReturnPct, probUp: h.probUp, p5: h.quantiles.p5, p95: h.quantiles.p95, confidence: h.confidence, realizedPct });
  }
  return out;
}

/** Rendements de l'indice à chaque horizon depuis chaque date (clé « ts:horizon »). */
export function indexReturns(indexByTs: Map<number, number>, dates: number[], horizons: Horizon[]): Map<string, number> {
  const timeline = [...indexByTs.keys()].sort((a, b) => a - b);
  const out = new Map<string, number>();
  for (const d of dates) {
    const i = timeline.indexOf(d);
    if (i < 0) continue;
    for (const h of horizons) {
      const j = i + HORIZON_DAYS[h];
      if (j < timeline.length) out.set(`${d}:${h}`, (indexByTs.get(timeline[j])! / indexByTs.get(d)! - 1) * 100);
    }
  }
  return out;
}

export function buildVerdict(horizons: HorizonEvaluation[]): string[] {
  const v: string[] = [];
  for (const h of horizons) {
    const parts: string[] = [];
    parts.push(`${h.horizon} : direction ${Math.round(h.hitRate * 100)} % (référence ${Math.round(h.baselineHitRate * 100)} %)`);
    parts.push(h.skill > 0 ? `erreur réduite de ${Math.round(h.skill * 100)} % par rapport à la prévision nulle` : `erreur ${Math.round(-h.skill * 100)} % au-dessus de la prévision nulle`);
    if (h.ic.mean != null) parts.push(`corrélation de rang ${h.ic.mean > 0 ? "+" : ""}${h.ic.mean.toFixed(3)}${h.ic.tStat != null ? ` (t = ${h.ic.tStat.toFixed(1)}${Math.abs(h.ic.tStat) >= 2 ? ", significative" : ", non significative"})` : ""}`);
    parts.push(`intervalle 90 % tenu ${Math.round(h.coverage90 * 100)} % du temps`);
    const s = h.strategy;
    parts.push(`stratégie ${s.topK.periods} périodes : ${s.topK.totalReturnPct > 0 ? "+" : ""}${s.topK.totalReturnPct.toFixed(1)} % net de frais contre ${s.equalWeight.totalReturnPct > 0 ? "+" : ""}${s.equalWeight.totalReturnPct.toFixed(1)} % équipondéré${s.index ? ` et ${s.index.totalReturnPct > 0 ? "+" : ""}${s.index.totalReturnPct.toFixed(1)} % indice` : ""}`);
    v.push(parts.join(" · "));
  }
  return v;
}

/** Évaluation complète, synchrone (le service la découpe par dates pour ne pas bloquer l'API). */
export function walkForwardEvaluation(input: EvaluationInput): EvaluationReport {
  const config = { ...DEFAULT_EVALUATION, ...input.config };
  const dates = evaluationDates(input.candlesBySymbol, config);
  const obs: Observation[] = [];
  let done = 0;
  for (const ts of dates) {
    for (const [symbol, candles] of input.candlesBySymbol) obs.push(...observeAt(symbol, candles, input.indexByTs, ts, config));
    input.onProgress?.(++done, dates.length);
  }
  return finalizeReport(obs, input.indexByTs, config, input.candlesBySymbol.size);
}

export function finalizeReport(obs: Observation[], indexByTs: Map<number, number>, config: EvaluationConfig, universe: number): EvaluationReport {
  const dates = [...new Set(obs.map((o) => o.ts))].sort((a, b) => a - b);
  const horizons = evaluateObservations(obs, indexReturns(indexByTs, dates, config.horizons), config);
  return { generatedAt: Date.now(), config, universe, firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null, horizons, verdict: buildVerdict(horizons) };
}
