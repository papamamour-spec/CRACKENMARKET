/**
 * Moteur de prévision Kraken.
 *
 * Pour chaque valeur et chaque horizon (1 semaine, 1 mois, 3 mois) :
 *  1. des facteurs calculés sur l'historique (momentum, retour à la moyenne, volatilité, RSI,
 *     volumes, pente, facteur marché, saisonnalité) ;
 *  2. une régression ridge entraînée en marche avant sur l'historique de la valeur
 *     (70 % apprentissage / 30 % test chronologique) qui mesure sa précision réelle
 *     (taux de bonne direction, erreur moyenne) avant d'être réajustée sur tout l'historique ;
 *  3. un modèle autorégressif AR(5) sur les rendements quotidiens ;
 *  4. un ensemble pondéré par l'erreur de test des deux modèles, ajusté par l'actualité ;
 *  5. une simulation de Monte-Carlo (volatilité EWMA) pour obtenir la distribution complète :
 *     probabilité de hausse, quantiles, probabilités de mouvements extrêmes.
 * Chaque prévision est accompagnée des contributions de chaque facteur, en points de pourcentage.
 *
 * Les prévisions sont probabilistes : la précision affichée est celle mesurée sur le passé de la
 * valeur, jamais une garantie.
 */
import { rsi, sma, slopePct, type Candle } from "./indicators.js";
import { gaussian, mean, quantile, ridge, rng, stddev } from "./linalg.js";

export type Horizon = "1W" | "1M" | "3M";
export const HORIZON_DAYS: Record<Horizon, number> = { "1W": 5, "1M": 21, "3M": 63 };

export interface Contribution {
  factor: string;
  label: string;
  value: number; // valeur brute lisible du facteur
  contributionPct: number; // en points de % de rendement attendu
}

export interface HorizonForecast {
  horizon: Horizon;
  horizonDays: number;
  expectedReturnPct: number;
  probUp: number;
  probAbove5: number;
  probBelow5: number;
  quantiles: { p5: number; p25: number; p50: number; p75: number; p95: number }; // rendements %
  priceTargets: { p5: number; p50: number; p95: number };
  /** précision mesurée en test chronologique (30 % des observations) */
  accuracy: { hitRate: number; baselineHitRate: number; maePct: number; naiveMaePct: number; samples: number };
  confidence: number; // 0..1
  models: { ridgePct: number; arPct: number; newsAdjustmentPct: number; weights: { ridge: number; ar: number } };
  contributions: Contribution[];
  explanations: string[];
}

export interface Forecast {
  symbol: string;
  price: number;
  generatedAt: number;
  dailyVolPct: number; // EWMA, annualisée
  horizons: HorizonForecast[];
  summary: string;
}

const FACTORS: { key: string; label: string; fmt: (v: number) => string }[] = [
  { key: "mom21", label: "Momentum 1 mois", fmt: (v) => `${(v * 100).toFixed(1)} %` },
  { key: "mom63", label: "Momentum 3 mois", fmt: (v) => `${(v * 100).toFixed(1)} %` },
  { key: "rev50", label: "Écart à la moyenne 50 séances", fmt: (v) => `${(v * 100).toFixed(1)} %` },
  { key: "vol20", label: "Volatilité 20 séances", fmt: (v) => `${(v * 100).toFixed(0)} % ann.` },
  { key: "rsi", label: "RSI 14", fmt: (v) => `${(50 + v * 50).toFixed(0)}` },
  { key: "volRatio", label: "Volumes 5 / 60 séances", fmt: (v) => `×${(1 + v).toFixed(2)}` },
  { key: "slope20", label: "Pente 20 séances", fmt: (v) => `${v.toFixed(2)} %/séance` },
  { key: "mkt21", label: "Momentum du marché 1 mois", fmt: (v) => `${(v * 100).toFixed(1)} %` },
  { key: "season", label: "Saisonnalité du mois", fmt: (v) => `${(v * 100).toFixed(1)} %` },
];

interface Row {
  x: number[];
  y: number;
  t: number;
}

function logReturns(closes: number[]): number[] {
  const r: number[] = [0];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}

/** Volatilité EWMA (λ = 0,94) des rendements quotidiens. */
export function ewmaVol(returns: number[], lambda = 0.94): number {
  let v = returns.length > 20 ? stddev(returns.slice(-60)) ** 2 : 0.0001;
  for (const r of returns.slice(-250)) v = lambda * v + (1 - lambda) * r * r;
  return Math.sqrt(v);
}

/** Facteurs à la date t (n'utilise que les données jusqu'à t inclus). */
function featuresAt(closes: number[], vols: number[], idx: number[] | null, sma50: number[], rsi14: number[], t: number, monthEffect: Map<number, number>, dates: number[]): number[] | null {
  if (t < 70) return null;
  const c = closes[t];
  const mom21 = Math.log(c / closes[t - 21]);
  const mom63 = Math.log(c / closes[t - 63]);
  const rev50 = Number.isFinite(sma50[t]) && sma50[t] > 0 ? c / sma50[t] - 1 : 0;
  const lr = logReturns(closes.slice(t - 20, t + 1)).slice(1);
  const vol20 = stddev(lr) * Math.sqrt(252);
  const rsiN = Number.isFinite(rsi14[t]) ? (rsi14[t] - 50) / 50 : 0;
  const v5 = mean(vols.slice(t - 4, t + 1));
  const v60 = mean(vols.slice(t - 59, t + 1)) || 1;
  const volRatio = Math.max(-1, Math.min(3, v5 / v60 - 1));
  const slope20 = slopePct(closes.slice(t - 19, t + 1));
  const mkt21 = idx && idx[t] && idx[t - 21] ? Math.log(idx[t] / idx[t - 21]) : 0;
  const month = new Date(dates[t]).getUTCMonth();
  const season = monthEffect.get(month) ?? 0;
  return [mom21, mom63, rev50, vol20, rsiN, volRatio, slope20, mkt21, season];
}

/** Effet saisonnier : rendement moyen à 21 séances observé pour chaque mois, sur la fenêtre donnée. */
function seasonality(closes: number[], dates: number[], upTo: number): Map<number, number> {
  const acc = new Map<number, number[]>();
  for (let t = 0; t + 21 <= upTo; t += 5) {
    const m = new Date(dates[t]).getUTCMonth();
    acc.set(m, [...(acc.get(m) ?? []), Math.log(closes[t + 21] / closes[t])]);
  }
  return new Map([...acc.entries()].map(([m, rs]) => [m, mean(rs)]));
}

function standardize(rows: Row[]): { mu: number[]; sd: number[] } {
  const k = rows[0].x.length;
  const mu = Array.from({ length: k }, (_, j) => mean(rows.map((r) => r.x[j])));
  const sd = Array.from({ length: k }, (_, j) => stddev(rows.map((r) => r.x[j])) || 1);
  return { mu, sd };
}

function z(x: number[], mu: number[], sd: number[]): number[] {
  return x.map((v, j) => (v - mu[j]) / sd[j]);
}

/** AR(p) sur les rendements quotidiens, prévision cumulée à h jours. */
function arForecast(returns: number[], h: number, p = 5): number {
  const r = returns.slice(-260);
  if (r.length < p + 30) return 0;
  const X: number[][] = [];
  const y: number[] = [];
  for (let t = p; t < r.length; t++) {
    X.push(r.slice(t - p, t));
    y.push(r[t]);
  }
  const beta = ridge(X, y, 0.5);
  const hist = r.slice(-p);
  let total = 0;
  for (let i = 0; i < h; i++) {
    const next = beta[0] + hist.slice(-p).reduce((s, v, j) => s + beta[j + 1] * v, 0);
    total += next;
    hist.push(next);
  }
  // les coefficients AR sont faibles et bruités : on atténue (shrinkage) l'extrapolation
  return total * 0.5;
}

export interface ForecastInput {
  symbol: string;
  candles: Candle[];
  /** historique de l'indice (clôtures) aligné sur les dates des bougies, facultatif */
  indexCloses?: number[] | null;
  /** sentiment d'actualité récent [-1, 1] et nombre d'articles */
  news?: { score: number; count: number };
  seed?: number;
}

export function forecast(input: ForecastInput): Forecast {
  const { candles } = input;
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const dates = candles.map((c) => c.ts);
  const n = closes.length;
  const price = closes[n - 1];
  const returns = logReturns(closes);
  const dailyVol = ewmaVol(returns.slice(1));
  const sma50 = sma(closes, 50);
  const rsi14 = rsi(closes, 14);
  const idx = input.indexCloses && input.indexCloses.length === n ? input.indexCloses : null;
  const rand = rng(input.seed ?? 42);
  const horizons: HorizonForecast[] = [];

  for (const horizon of ["1W", "1M", "3M"] as Horizon[]) {
    const h = HORIZON_DAYS[horizon];
    // Jeu d'apprentissage : une observation toutes les 2 séances pour limiter l'autocorrélation
    const rows: Row[] = [];
    const seasonTrain = seasonality(closes, dates, Math.max(0, n - 1 - h));
    for (let t = 70; t + h < n; t += 2) {
      const x = featuresAt(closes, vols, idx, sma50, rsi14, t, seasonTrain, dates);
      if (!x) continue;
      rows.push({ x, y: Math.log(closes[t + h] / closes[t]), t });
    }
    const lambda = 5;
    let hitRate = 0.5;
    let baselineHitRate = 0.5;
    let maePct = 0;
    let naiveMaePct = 0;
    let samples = 0;
    let ridgeTestMae = Infinity;
    let arTestMae = Infinity;
    if (rows.length >= 60) {
      const split = Math.floor(rows.length * 0.7);
      const train = rows.slice(0, split);
      const test = rows.slice(split);
      const { mu, sd } = standardize(train);
      const beta = ridge(train.map((r) => z(r.x, mu, sd)), train.map((r) => r.y), lambda);
      let hits = 0;
      let ups = 0;
      let errSum = 0;
      let naiveSum = 0;
      let arErr = 0;
      for (const r of test) {
        const pred = beta[0] + z(r.x, mu, sd).reduce((s, v, j) => s + beta[j + 1] * v, 0);
        if (Math.sign(pred) === Math.sign(r.y) && pred !== 0) hits++;
        if (r.y > 0) ups++;
        errSum += Math.abs(pred - r.y);
        naiveSum += Math.abs(r.y);
        arErr += Math.abs(arForecast(returns.slice(1, r.t + 1), h) - r.y);
      }
      samples = test.length;
      hitRate = hits / samples;
      // référence naïve : « toujours en hausse » (dérive positive des actions), sans recours au futur
      baselineHitRate = ups / samples;
      maePct = (errSum / samples) * 100;
      naiveMaePct = (naiveSum / samples) * 100;
      ridgeTestMae = errSum / samples;
      arTestMae = arErr / samples;
    }
    // Réajustement sur l'ensemble des observations pour la prévision courante
    let ridgePct = 0;
    const contributions: Contribution[] = [];
    const seasonAll = seasonality(closes, dates, n - 1);
    const xNow = featuresAt(closes, vols, idx, sma50, rsi14, n - 1, seasonAll, dates);
    if (rows.length >= 60 && xNow) {
      const { mu, sd } = standardize(rows);
      const beta = ridge(rows.map((r) => z(r.x, mu, sd)), rows.map((r) => r.y), lambda);
      const zx = z(xNow, mu, sd);
      let pred = beta[0];
      for (let j = 0; j < zx.length; j++) {
        const contrib = beta[j + 1] * zx[j];
        pred += contrib;
        contributions.push({ factor: FACTORS[j].key, label: FACTORS[j].label, value: xNow[j], contributionPct: Math.round(contrib * 1000) / 10 });
      }
      contributions.push({ factor: "base", label: "Dérive moyenne de la valeur", value: beta[0], contributionPct: Math.round(beta[0] * 1000) / 10 });
      // bornage : une régression sur 1 500 observations ne doit pas extrapoler au-delà de 3 écarts-types
      const cap = 3 * dailyVol * Math.sqrt(h);
      ridgePct = Math.max(-cap, Math.min(cap, pred)) * 100;
    }
    // Rétrécissement vers la dérive historique quand le modèle n'améliore pas nettement l'erreur naïve
    // (prévision nulle) en test : ratio ≤ 0,95 → plein ; 1,0 → moitié ; ≥ 1,025 → quart.
    const drift = rows.length ? mean(rows.map((r) => r.y)) * 100 : 0;
    const shrinkOf = (mae: number) => (Number.isFinite(mae) && naiveMaePct > 0 ? Math.max(0.25, Math.min(1, (1.05 - (mae * 100) / naiveMaePct) / 0.1)) : 1);
    const ridgeShrink = shrinkOf(ridgeTestMae);
    const arShrink = shrinkOf(arTestMae);
    ridgePct = drift + ridgeShrink * (ridgePct - drift);
    const arPct = drift + arShrink * (arForecast(returns.slice(1), h) * 100 - drift);
    // Pondération par l'inverse de l'erreur de test
    const wr = Number.isFinite(ridgeTestMae) && ridgeTestMae > 0 ? 1 / ridgeTestMae : 1;
    const wa = Number.isFinite(arTestMae) && arTestMae > 0 ? 1 / arTestMae : 0.6;
    const wsum = wr + wa;
    const weights = { ridge: Math.round((wr / wsum) * 100) / 100, ar: Math.round((wa / wsum) * 100) / 100 };
    let expected = (ridgePct * wr + arPct * wa) / wsum;
    // Actualité : décalage proportionnel au sentiment, borné à ±1 volatilité d'horizon
    let newsAdj = 0;
    if (input.news && input.news.count > 0 && Math.abs(input.news.score) >= 0.15) {
      newsAdj = Math.max(-1, Math.min(1, input.news.score)) * dailyVol * Math.sqrt(h) * 100 * 0.5;
      expected += newsAdj;
    }
    // Monte-Carlo : 1 000 trajectoires, dérive = espérance de l'ensemble, volatilité EWMA
    const paths = 1000;
    const driftDaily = Math.log(1 + expected / 100) / h;
    const outcomes: number[] = [];
    for (let p = 0; p < paths; p++) {
      let lp = 0;
      for (let d = 0; d < h; d++) lp += driftDaily - 0.5 * dailyVol * dailyVol + dailyVol * gaussian(rand);
      outcomes.push((Math.exp(lp) - 1) * 100);
    }
    outcomes.sort((a, b) => a - b);
    const q = (p: number) => Math.round(quantile(outcomes, p) * 10) / 10;
    const probUp = outcomes.filter((o) => o > 0).length / paths;
    const probAbove5 = outcomes.filter((o) => o > 5).length / paths;
    const probBelow5 = outcomes.filter((o) => o < -5).length / paths;
    const skill = Math.max(0, hitRate - baselineHitRate) + Math.max(0, hitRate - 0.5) * 0.5;
    const confidence = Math.max(0.1, Math.min(0.9, 0.3 + skill * 2 + Math.min(0.2, samples / 1000)));

    const sortedContrib = [...contributions].filter((c) => c.factor !== "base").sort((a, b) => Math.abs(b.contributionPct) - Math.abs(a.contributionPct));
    const explanations: string[] = [];
    for (const c of sortedContrib.slice(0, 3)) {
      if (Math.abs(c.contributionPct) < 0.2) continue;
      const f = FACTORS.find((x) => x.key === c.factor)!;
      explanations.push(`${c.label} (${f.fmt(c.value)}) ${c.contributionPct > 0 ? "soutient" : "pèse sur"} la prévision : ${c.contributionPct > 0 ? "+" : ""}${c.contributionPct.toFixed(1)} pt`);
    }
    if (Math.abs(arPct) >= 0.3) explanations.push(`Le modèle autorégressif sur les rendements quotidiens ${arPct > 0 ? "anticipe une poursuite" : "anticipe un essoufflement"} (${arPct > 0 ? "+" : ""}${arPct.toFixed(1)} %)`);
    if (newsAdj !== 0) explanations.push(`Actualité récente ${newsAdj > 0 ? "favorable" : "défavorable"} : ${newsAdj > 0 ? "+" : ""}${newsAdj.toFixed(1)} pt`);
    if (ridgeShrink < 1 && samples >= 30) explanations.push(`Le modèle n'améliore que peu l'erreur naïve en test : prévision ramenée à ${Math.round(ridgeShrink * 100)} % de son écart à la dérive historique (${drift > 0 ? "+" : ""}${drift.toFixed(1)} %)`);
    explanations.push(samples >= 30 ? `Sur ${samples} fenêtres de test passées, la direction a été correcte ${Math.round(hitRate * 100)} % du temps (référence « toujours en hausse » : ${Math.round(baselineHitRate * 100)} %)` : "Historique de test insuffisant : prévision peu fiable");

    horizons.push({
      horizon,
      horizonDays: h,
      expectedReturnPct: Math.round(expected * 10) / 10,
      probUp: Math.round(probUp * 100) / 100,
      probAbove5: Math.round(probAbove5 * 100) / 100,
      probBelow5: Math.round(probBelow5 * 100) / 100,
      quantiles: { p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) },
      priceTargets: { p5: Math.round(price * (1 + q(0.05) / 100)), p50: Math.round(price * (1 + q(0.5) / 100)), p95: Math.round(price * (1 + q(0.95) / 100)) },
      accuracy: { hitRate: Math.round(hitRate * 100) / 100, baselineHitRate: Math.round(baselineHitRate * 100) / 100, maePct: Math.round(maePct * 10) / 10, naiveMaePct: Math.round(naiveMaePct * 10) / 10, samples },
      confidence: Math.round(confidence * 100) / 100,
      models: { ridgePct: Math.round(ridgePct * 10) / 10, arPct: Math.round(arPct * 10) / 10, newsAdjustmentPct: Math.round(newsAdj * 10) / 10, weights },
      contributions,
      explanations,
    });
  }

  const m = horizons[1];
  const tone = m.expectedReturnPct >= 2 ? "haussière" : m.expectedReturnPct <= -2 ? "baissière" : "neutre";
  const summary = `Tendance ${tone} à 1 mois : ${m.expectedReturnPct > 0 ? "+" : ""}${m.expectedReturnPct} % attendu (probabilité de hausse ${Math.round(m.probUp * 100)} %, intervalle 90 % de ${m.quantiles.p5} % à ${m.quantiles.p95} %), précision historique ${Math.round(m.accuracy.hitRate * 100)} %.`;

  return { symbol: input.symbol, price, generatedAt: Date.now(), dailyVolPct: Math.round(dailyVol * Math.sqrt(252) * 1000) / 10, horizons, summary };
}
