/**
 * Méta-étiquetage, triple barrière et dimensionnement de Kelly (moteur court terme, étape 2).
 *
 * Le modèle primaire (ensemble de prévisions : ridge, AR, panel, événements) dit *où* le rendement
 * attendu est positif. Le modèle secondaire ne cherche pas de nouveaux signaux : il apprend, sur
 * l'historique en marche avant, la probabilité que ce signal réussisse dans le contexte du moment
 * (force et fiabilité mesurée du signal, volatilité, régime de marché, saison, signaux événementiels).
 * C'est le méta-étiquetage de López de Prado : on filtre les faux positifs du primaire et on
 * dimensionne les positions par la probabilité apprise.
 *
 * Triple barrière : chaque position a dès l'entrée un objectif de gain, un seuil de perte et une
 * durée maximale, posés selon la volatilité du titre ; la première barrière touchée clôture (sur les
 * clôtures : la BRVM n'a pas de cotation continue exploitable). L'étiquette d'apprentissage est
 * « la position aurait été gagnante nette de frais ».
 *
 * Kelly : pour un pari asymétrique (gain g si succès, perte l si échec, probabilité p), la fraction
 * optimale est f* = p / l − (1 − p) / g ; on en prend le quart (Kelly fractionnaire), borné par le
 * poids maximal par ligne et le plafond de liquidité. C'est la concentration qui porte le rendement
 * à court terme, le quart de Kelly qui évite la ruine.
 */
import { solve } from "./linalg.js";

export interface BarrierSpec {
  /** objectif de gain (décimal) */
  profit: number;
  /** seuil de perte (décimal, positif) */
  stop: number;
  /** durée maximale en séances */
  maxSessions: number;
}

export type BarrierReason = "objectif" | "seuil" | "échéance";

export interface BarrierOutcome {
  reason: BarrierReason;
  /** indice de la bougie de sortie */
  exitIndex: number;
  sessions: number;
  /** rendement brut de l'entrée à la sortie (décimal) */
  ret: number;
}

/** Barrières à partir de la volatilité quotidienne (décimale) : objectif 1,5 σ_h, seuil 1 σ_h, échéance 2 h. */
export function barriersFor(dailyVol: number, horizonSessions = 21, kProfit = 1.5, kStop = 1.0): BarrierSpec {
  const sigma = Math.max(0.02, Math.min(0.6, dailyVol * Math.sqrt(horizonSessions)));
  return { profit: Math.round(kProfit * sigma * 1000) / 1000, stop: Math.round(kStop * sigma * 1000) / 1000, maxSessions: 2 * horizonSessions };
}

/**
 * Première barrière touchée après l'entrée à `t` (clôture de t) sur les clôtures suivantes. Null si les
 * données s'arrêtent avant qu'une barrière ou l'échéance ne soit atteinte (étiquette inconnue).
 */
export function tripleBarrier(closes: number[], t: number, spec: BarrierSpec): BarrierOutcome | null {
  const entry = closes[t];
  if (!(entry > 0)) return null;
  for (let i = t + 1; i <= Math.min(closes.length - 1, t + spec.maxSessions); i++) {
    const r = closes[i] / entry - 1;
    if (r >= spec.profit) return { reason: "objectif", exitIndex: i, sessions: i - t, ret: r };
    if (r <= -spec.stop) return { reason: "seuil", exitIndex: i, sessions: i - t, ret: r };
    if (i - t >= spec.maxSessions) return { reason: "échéance", exitIndex: i, sessions: i - t, ret: r };
  }
  return null;
}

export const META_FEATURES: { key: string; label: string }[] = [
  { key: "expected", label: "Rendement attendu à 1 mois (primaire)" },
  { key: "probUp", label: "Probabilité de hausse (primaire)" },
  { key: "confidence", label: "Confiance du primaire" },
  { key: "skill", label: "Précision mesurée − référence" },
  { key: "vol", label: "Volatilité annualisée" },
  { key: "volRatio", label: "Volumes 5 / 60 séances" },
  { key: "rev50", label: "Écart à la moyenne 50 séances" },
  { key: "mkt63", label: "Momentum du marché 3 mois" },
  { key: "mktVol", label: "Volatilité du marché 20 séances" },
  { key: "season", label: "Saison des résultats et dividendes (février–juin)" },
  { key: "pubDrift", label: "Dérive post-publication" },
  { key: "divWindow", label: "Fenêtre de dividende" },
  { key: "book5", label: "Pression du carnet officiel" },
  { key: "resMom", label: "Momentum résiduel" },
];

export interface MetaContext {
  expectedPct: number;
  probUp: number;
  confidence: number;
  hitRate: number;
  baselineHitRate: number;
  /** volatilité annualisée (%) */
  dailyVolPct: number;
  /** clôtures et volumes jusqu'à la date incluse */
  closes: number[];
  volumes: number[];
  /** clôtures de l'indice alignées (ou null) */
  index: (number | null)[] | null;
  month: number;
  signals: { pubDrift: number; divWindow: number; book5: number; resMom: number };
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Vecteur de contexte du signal primaire à une date (ordre de META_FEATURES). */
export function metaFeatures(c: MetaContext): number[] {
  const n = c.closes.length;
  const last = c.closes[n - 1];
  const v5 = c.volumes.slice(-5).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(5, n));
  const v60 = c.volumes.slice(-60).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(60, n)) || 1;
  const volRatio = Math.max(-1, Math.min(3, v5 / v60 - 1));
  const w50 = c.closes.slice(-50);
  const sma50 = w50.reduce((a, b) => a + b, 0) / w50.length;
  const rev50 = sma50 > 0 ? last / sma50 - 1 : 0;
  let mkt63 = 0;
  let mktVol = 0;
  if (c.index && n > 64) {
    const i0 = c.index[n - 64];
    const i1 = c.index[n - 1];
    if (i0 != null && i1 != null && i0 > 0 && i1 > 0) mkt63 = Math.log(i1 / i0);
    const lr: number[] = [];
    for (let i = n - 20; i < n; i++) {
      const a = c.index[i - 1];
      const b = c.index[i];
      if (a != null && b != null && a > 0 && b > 0) lr.push(Math.log(b / a));
    }
    mktVol = stdev(lr) * Math.sqrt(252);
  }
  const season = c.month >= 1 && c.month <= 5 ? 1 : 0; // février (1) à juin (5)
  return [c.expectedPct / 10, c.probUp, c.confidence, c.hitRate - c.baselineHitRate, c.dailyVolPct / 100, volRatio, rev50, mkt63, mktVol, season, c.signals.pubDrift, c.signals.divWindow, c.signals.book5, c.signals.resMom];
}

export interface LogisticModel {
  mu: number[];
  sd: number[];
  /** β₀ puis un coefficient par variable standardisée */
  beta: number[];
  lambda: number;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** Régression logistique L2 par Newton-Raphson sur variables standardisées (constante non pénalisée). */
export function fitLogistic(X: number[][], y: number[], lambda = 1, iterations = 30): LogisticModel {
  const k = X[0].length;
  const n = X.length;
  const mu = Array.from({ length: k }, (_, j) => X.reduce((a, r) => a + r[j], 0) / n);
  const sd = Array.from({ length: k }, (_, j) => stdev(X.map((r) => r[j])) || 1);
  const Z = X.map((r) => [1, ...r.map((v, j) => (v - mu[j]) / sd[j])]);
  let beta = new Array<number>(k + 1).fill(0);
  const base = y.reduce((a: number, b) => a + b, 0) / n;
  beta[0] = Math.log(Math.max(1e-6, base) / Math.max(1e-6, 1 - base));
  for (let it = 0; it < iterations; it++) {
    const grad = new Array<number>(k + 1).fill(0);
    const H = Array.from({ length: k + 1 }, () => new Array<number>(k + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const z = Z[i];
      const p = sigmoid(z.reduce((a, v, j) => a + v * beta[j], 0));
      const w = p * (1 - p);
      for (let a = 0; a <= k; a++) {
        grad[a] += (y[i] - p) * z[a];
        for (let b = 0; b <= k; b++) H[a][b] += w * z[a] * z[b];
      }
    }
    for (let a = 1; a <= k; a++) { grad[a] -= lambda * beta[a]; H[a][a] += lambda; }
    const step = solve(H, grad);
    beta = beta.map((b, j) => b + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return { mu, sd, beta, lambda };
}

export function predictLogistic(m: LogisticModel, x: number[]): number {
  let z = m.beta[0];
  for (let j = 0; j < x.length; j++) z += m.beta[j + 1] * ((x[j] - m.mu[j]) / m.sd[j]);
  return sigmoid(z);
}

/** Aire sous la courbe ROC (statistique de Mann-Whitney), null si une classe manque. */
export function auc(p: number[], y: number[]): number | null {
  const pos = p.filter((_, i) => y[i] === 1);
  const neg = p.filter((_, i) => y[i] === 0);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

export interface MetaObservation {
  ts: number;
  symbol: string;
  x: number[];
  /** 1 si la position aurait été gagnante nette de frais */
  y: 0 | 1;
  retPct: number;
  reason: BarrierReason;
}

export interface MetaStats {
  n: number;
  baseRate: number;
  testN: number;
  /** précision du modèle à 0,5 et de la règle « toujours oui » sur le test chronologique */
  accuracy: number | null;
  baselineAccuracy: number | null;
  auc: number | null;
  brier: number | null;
  baselineBrier: number | null;
  /** fiabilité : probabilité annoncée contre fréquence observée, en test */
  calibration: { from: number; to: number; n: number; predicted: number | null; observed: number | null }[];
  /** rendement moyen (%) des positions dont la probabilité dépasse 0,55 contre toutes, en test */
  selectedReturnPct: number | null;
  allReturnPct: number | null;
  selectedShare: number | null;
  /** poids standardisés (lisibles) */
  coefficients: { key: string; label: string; beta: number }[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Entraîne le modèle secondaire avec test chronologique (30 % les plus récents) puis réajuste sur tout. */
export function trainMetaModel(obs: MetaObservation[], lambda = 2, minProb = 0.55): { model: LogisticModel; stats: MetaStats } {
  if (obs.length < 60) throw new Error(`Observations insuffisantes pour le méta-étiquetage (${obs.length} < 60)`);
  const sorted = [...obs].sort((a, b) => a.ts - b.ts);
  const cut = sorted[Math.floor(sorted.length * 0.7)].ts;
  const fit = sorted.filter((o) => o.ts < cut);
  const test = sorted.filter((o) => o.ts >= cut);
  const stats: MetaStats = { n: obs.length, baseRate: r3(obs.filter((o) => o.y === 1).length / obs.length), testN: test.length, accuracy: null, baselineAccuracy: null, auc: null, brier: null, baselineBrier: null, calibration: [], selectedReturnPct: null, allReturnPct: null, selectedShare: null, coefficients: [] };
  if (fit.length >= 40 && test.length >= 20) {
    const m = fitLogistic(fit.map((o) => o.x), fit.map((o) => o.y), lambda);
    const p = test.map((o) => predictLogistic(m, o.x));
    const y = test.map((o) => o.y);
    const base = fit.filter((o) => o.y === 1).length / fit.length;
    stats.accuracy = r3(p.filter((v, i) => (v >= 0.5 ? 1 : 0) === y[i]).length / test.length);
    stats.baselineAccuracy = r3(y.filter((v) => v === (base >= 0.5 ? 1 : 0)).length / test.length);
    stats.auc = auc(p, y) != null ? r3(auc(p, y)!) : null;
    stats.brier = r3(p.reduce((a, v, i) => a + (v - y[i]) ** 2, 0) / test.length);
    stats.baselineBrier = r3(y.reduce((a: number, v) => a + (base - v) ** 2, 0) / test.length);
    const edges = [0, 0.4, 0.5, 0.55, 0.6, 0.7, 1.0001];
    for (let i = 0; i + 1 < edges.length; i++) {
      const idx = p.map((v, k) => (v >= edges[i] && v < edges[i + 1] ? k : -1)).filter((k) => k >= 0);
      stats.calibration.push({ from: edges[i], to: Math.min(1, edges[i + 1]), n: idx.length, predicted: idx.length ? r3(idx.reduce((a, k) => a + p[k], 0) / idx.length) : null, observed: idx.length ? r3(idx.filter((k) => y[k] === 1).length / idx.length) : null });
    }
    const sel = test.filter((_, i) => p[i] >= minProb);
    stats.selectedShare = r3(sel.length / test.length);
    stats.selectedReturnPct = sel.length ? r3(sel.reduce((a, o) => a + o.retPct, 0) / sel.length) : null;
    stats.allReturnPct = r3(test.reduce((a, o) => a + o.retPct, 0) / test.length);
  }
  const model = fitLogistic(sorted.map((o) => o.x), sorted.map((o) => o.y), lambda);
  stats.coefficients = META_FEATURES.map((f, j) => ({ key: f.key, label: f.label, beta: r3(model.beta[j + 1]) }));
  return { model, stats };
}

/** Fraction de Kelly pour un pari asymétrique, au `fraction` (quart par défaut) ; 0 si l'espérance est négative. */
export function kellyFraction(p: number, gain: number, loss: number, fraction = 0.25): number {
  if (!(gain > 0) || !(loss > 0)) return 0;
  const f = p / loss - (1 - p) / gain;
  return Math.max(0, f * fraction);
}

export interface BasketCandidate {
  symbol: string;
  price: number;
  prob: number;
  expectedPct: number;
  barriers: BarrierSpec;
  /** plafond de poids par la liquidité (décimal) */
  liquidityCap: number;
}

export interface BasketLine extends BasketCandidate {
  kelly: number;
  weightPct: number;
}

export interface BasketOptions {
  maxLines?: number;
  minProb?: number;
  maxWeightPct?: number;
  fraction?: number;
  /** frais aller-retour (décimal) retranchés du gain et ajoutés à la perte */
  roundTripCost?: number;
}

/**
 * Panier court terme : candidats dont la probabilité apprise dépasse le seuil, classés par espérance
 * (p × gain − (1 − p) × perte), dimensionnés au quart de Kelly, bornés par le poids maximal et la
 * liquidité, au plus `maxLines` lignes ; le reste est en liquidités (jamais de levier).
 */
export function buildBasket(cands: BasketCandidate[], opts: BasketOptions = {}): { lines: BasketLine[]; cashPct: number } {
  const maxLines = opts.maxLines ?? 8;
  const minProb = opts.minProb ?? 0.55;
  const maxW = (opts.maxWeightPct ?? 20) / 100;
  const cost = opts.roundTripCost ?? 0.015;
  const scored = cands
    .filter((c) => c.prob >= minProb && c.expectedPct > 0)
    .map((c) => {
      const gain = Math.max(0.001, c.barriers.profit - cost);
      const loss = c.barriers.stop + cost;
      return { c, edge: c.prob * gain - (1 - c.prob) * loss, kelly: kellyFraction(c.prob, gain, loss, opts.fraction ?? 0.25) };
    })
    .filter((s) => s.edge > 0 && s.kelly > 0)
    .sort((a, b) => b.edge - a.edge)
    .slice(0, maxLines);
  let lines: BasketLine[] = scored.map((s) => ({ ...s.c, kelly: Math.round(s.kelly * 1000) / 1000, weightPct: Math.min(s.kelly, maxW, s.c.liquidityCap) * 100 }));
  const total = lines.reduce((a, l) => a + l.weightPct, 0);
  if (total > 100) lines = lines.map((l) => ({ ...l, weightPct: (l.weightPct * 100) / total }));
  lines = lines.map((l) => ({ ...l, weightPct: Math.round(l.weightPct * 10) / 10 }));
  return { lines, cashPct: Math.round((100 - lines.reduce((a, l) => a + l.weightPct, 0)) * 10) / 10 };
}
