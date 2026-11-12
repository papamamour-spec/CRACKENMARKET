/**
 * Modèle de risque factoriel et mesures de perte.
 *
 * Une covariance échantillon sur 47 titres et quelques centaines de séances est bruitée : ses petites
 * valeurs propres sont presque aléatoires et l'optimiseur s'y engouffre. Le modèle factoriel décrit
 * chaque valeur par son exposition à quelques facteurs communs — marché (indice composite), taille
 * (petites moins grandes capitalisations), rendement (fort moins faible rendement du dividende) et
 * secteur (moyenne du secteur moins le marché) — plus un risque spécifique :
 *   r_i = α_i + Σ_f β_if F_f + ε_i,    Σ = B Φ B' + D
 * (Φ covariance des facteurs, D variances spécifiques). La covariance retenue par l'optimiseur mélange
 * cette structure et l'échantillon rétréci (λ = 0,5 par défaut).
 *
 * La CVaR historique à 95 % sur un mois (moyenne des 5 % de pires rendements glissants sur 21 séances)
 * et la perte maximale de la combinaison servent de contrainte de perte, plus parlante qu'une variance.
 */
import { solve } from "./linalg.js";
import { shrinkCovariance } from "./optimizer.js";

export interface FactorAsset {
  symbol: string;
  sector: string;
  /** capitalisation (ou son proxy) pour le facteur taille */
  marketCap: number;
  /** rendement du dividende (%) pour le facteur rendement */
  dividendYieldPct: number;
}

export interface FactorModel {
  symbols: string[];
  factors: string[];
  /** expositions k × F */
  loadings: number[][];
  /** covariance annualisée des facteurs F × F */
  factorCov: number[][];
  /** variances spécifiques annualisées */
  specificVar: number[];
  /** covariance structurée annualisée B Φ B' + D */
  cov: number[][];
  /** part de variance expliquée par les facteurs, par valeur */
  r2: number[];
  /** bêta de marché par valeur */
  beta: number[];
  observations: number;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

function covMatrix(series: number[][], periodsPerYear: number): number[][] {
  const f = series.length;
  const n = series[0]?.length ?? 0;
  const m = series.map(mean);
  const out = Array.from({ length: f }, () => new Array<number>(f).fill(0));
  for (let i = 0; i < f; i++) for (let j = i; j < f; j++) {
    let s = 0;
    for (let t = 0; t < n; t++) s += (series[i][t] - m[i]) * (series[j][t] - m[j]);
    const c = (s / Math.max(1, n - 1)) * periodsPerYear;
    out[i][j] = c;
    out[j][i] = c;
  }
  return out;
}

/** Régression linéaire ridge y ~ 1 + X (λ faible pour la stabilité) ; renvoie les coefficients hors constante et le R². */
function ridge(y: number[], X: number[][], lambda = 1e-4): { beta: number[]; r2: number; residVar: number } {
  const n = y.length;
  const p = X.length ? X[0].length : 0;
  const cols = p + 1;
  const xtx = Array.from({ length: cols }, () => new Array<number>(cols).fill(0));
  const xty = new Array<number>(cols).fill(0);
  for (let t = 0; t < n; t++) {
    const row = [1, ...X[t]];
    for (let i = 0; i < cols; i++) {
      xty[i] += row[i] * y[t];
      for (let j = 0; j < cols; j++) xtx[i][j] += row[i] * row[j];
    }
  }
  for (let i = 1; i < cols; i++) xtx[i][i] += lambda * n;
  const b = solve(xtx, xty);
  const my = mean(y);
  let sse = 0;
  let sst = 0;
  for (let t = 0; t < n; t++) {
    const pred = b[0] + X[t].reduce((s, x, j) => s + x * b[j + 1], 0);
    sse += (y[t] - pred) ** 2;
    sst += (y[t] - my) ** 2;
  }
  return { beta: b.slice(1).map((v) => (Number.isFinite(v) ? v : 0)), r2: sst > 0 ? Math.max(0, 1 - sse / sst) : 0, residVar: sse / Math.max(1, n - cols) };
}

/**
 * Construit le modèle sur des rendements quotidiens alignés par la fin (comme la covariance échantillon) :
 * `returns[i]` est la série de la valeur i, `index` celle de l'indice composite.
 */
export function buildFactorModel(assets: FactorAsset[], returns: number[][], index: number[], periodsPerYear = 252): FactorModel {
  const k = assets.length;
  const n = Math.min(index.length, ...returns.map((r) => r.length));
  const R = returns.map((r) => r.slice(-n));
  const M = index.slice(-n);
  const factors: string[] = ["marché"];
  const series: number[][] = [M];
  // taille : moitié des petites capitalisations moins moitié des grandes
  const byCap = assets.map((a, i) => ({ i, cap: a.marketCap })).filter((x) => x.cap > 0).sort((a, b) => a.cap - b.cap);
  let sizeIdx = -1;
  if (byCap.length >= 4) {
    const half = Math.floor(byCap.length / 2);
    const small = byCap.slice(0, half).map((x) => x.i);
    const big = byCap.slice(byCap.length - half).map((x) => x.i);
    series.push(Array.from({ length: n }, (_, t) => mean(small.map((i) => R[i][t])) - mean(big.map((i) => R[i][t]))));
    factors.push("taille");
    sizeIdx = factors.length - 1;
  }
  // rendement : fort rendement moins faible rendement
  const byYield = assets.map((a, i) => ({ i, y: a.dividendYieldPct })).sort((a, b) => a.y - b.y);
  let yieldIdx = -1;
  if (byYield.length >= 4) {
    const half = Math.floor(byYield.length / 2);
    const low = byYield.slice(0, half).map((x) => x.i);
    const high = byYield.slice(byYield.length - half).map((x) => x.i);
    series.push(Array.from({ length: n }, (_, t) => mean(high.map((i) => R[i][t])) - mean(low.map((i) => R[i][t]))));
    factors.push("rendement");
    yieldIdx = factors.length - 1;
  }
  // secteurs : moyenne du secteur moins le marché, pour les secteurs d'au moins deux valeurs
  const sectorIdx = new Map<string, number>();
  const members = new Map<string, number[]>();
  assets.forEach((a, i) => members.set(a.sector, [...(members.get(a.sector) ?? []), i]));
  for (const [sector, idxs] of members) {
    if (idxs.length < 2) continue;
    series.push(Array.from({ length: n }, (_, t) => mean(idxs.map((i) => R[i][t])) - M[t]));
    factors.push(`secteur ${sector}`);
    sectorIdx.set(sector, factors.length - 1);
  }
  const F = factors.length;
  const factorCov = covMatrix(series, periodsPerYear);
  const loadings: number[][] = [];
  const specificVar: number[] = [];
  const r2: number[] = [];
  const beta: number[] = [];
  for (let i = 0; i < k; i++) {
    const cols: number[] = [0];
    if (sizeIdx >= 0) cols.push(sizeIdx);
    if (yieldIdx >= 0) cols.push(yieldIdx);
    const s = sectorIdx.get(assets[i].sector);
    if (s != null) cols.push(s);
    const X = Array.from({ length: n }, (_, t) => cols.map((c) => series[c][t]));
    const fit = ridge(R[i], X);
    const row = new Array<number>(F).fill(0);
    cols.forEach((c, j) => { row[c] = fit.beta[j]; });
    loadings.push(row);
    specificVar.push(fit.residVar * periodsPerYear);
    r2.push(r4(fit.r2));
    beta.push(r4(fit.beta[0]));
  }
  const cov = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++) for (let j = i; j < k; j++) {
    let s = 0;
    for (let a = 0; a < F; a++) {
      if (!loadings[i][a]) continue;
      for (let b = 0; b < F; b++) s += loadings[i][a] * factorCov[a][b] * loadings[j][b];
    }
    if (i === j) s += specificVar[i];
    cov[i][j] = s;
    cov[j][i] = s;
  }
  return { symbols: assets.map((a) => a.symbol), factors, loadings, factorCov, specificVar, cov, r2, beta, observations: n };
}

/** Covariance retenue : λ × structure factorielle + (1 − λ) × échantillon rétréci. */
export function blendedCovariance(model: FactorModel, returns: number[][], lambda = 0.5, periodsPerYear = 252): number[][] {
  const sample = shrinkCovariance(returns, 0.3, periodsPerYear);
  return model.cov.map((row, i) => row.map((v, j) => lambda * v + (1 - lambda) * sample[i][j]));
}

/** Sous-matrice d'une covariance indexée par symbole, dans l'ordre demandé (null si un symbole manque). */
export function covarianceFor(symbols: string[], all: { symbols: string[]; matrix: number[][] }): number[][] | null {
  const pos = new Map(all.symbols.map((s, i) => [s, i]));
  if (symbols.some((s) => !pos.has(s))) return null;
  return symbols.map((a) => symbols.map((b) => all.matrix[pos.get(a)!][pos.get(b)!]));
}

export interface LossMeasures {
  /** CVaR historique (perte moyenne des 5 % de pires fenêtres), décimal positif */
  cvar: number;
  /** VaR historique au même niveau */
  var: number;
  /** perte maximale depuis un plus haut sur la série de la combinaison */
  maxDrawdown: number;
  windows: number;
}

/**
 * Pertes historiques de la combinaison w (poids sur la valeur totale, le reste en liquidités) :
 * rendements glissants sur `horizonDays` séances (log, chevauchants) et perte maximale.
 */
export function lossMeasures(weights: number[], returns: number[][], horizonDays = 21, alpha = 0.95): LossMeasures {
  const n = Math.min(...returns.map((r) => r.length));
  if (!Number.isFinite(n) || n < horizonDays + 5) return { cvar: 0, var: 0, maxDrawdown: 0, windows: 0 };
  const port: number[] = [];
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let i = 0; i < weights.length; i++) s += weights[i] * returns[i][returns[i].length - n + t];
    port.push(s);
  }
  const rolling: number[] = [];
  let acc = 0;
  for (let t = 0; t < port.length; t++) {
    acc += port[t];
    if (t >= horizonDays) acc -= port[t - horizonDays];
    if (t >= horizonDays - 1) rolling.push(Math.exp(acc) - 1);
  }
  rolling.sort((a, b) => a - b);
  const m = Math.max(1, Math.floor(rolling.length * (1 - alpha)));
  const tail = rolling.slice(0, m);
  const cvar = Math.max(0, -mean(tail));
  const v = Math.max(0, -rolling[m - 1]);
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const r of port) {
    cum += r;
    peak = Math.max(peak, cum);
    maxDd = Math.min(maxDd, cum - peak);
  }
  return { cvar: r4(cvar), var: r4(v), maxDrawdown: r4(1 - Math.exp(maxDd)), windows: rolling.length };
}

/** Limite de CVaR à un mois (décimal) selon la tolérance au risque 1…5. */
export function cvarLimitFor(riskTolerance: number): number {
  const t = Math.max(1, Math.min(5, Math.round(riskTolerance)));
  return [0.06, 0.09, 0.12, 0.16, 0.22][t - 1];
}
