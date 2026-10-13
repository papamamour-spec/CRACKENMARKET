/**
 * Optimiseur de portefeuille (moyenne-variance sous contraintes).
 *
 * Entrées : rendements annuels attendus par valeur (prévision + dividende), matrice de covariance
 * annualisée des rendements (rétrécie vers la diagonale pour la stabilité), contraintes
 * (poids max par ligne et par secteur, exclusions, nombre de lignes max, part investie max).
 * Objectif : pour un rendement cible r*, minimiser la variance sous μ'w ≥ r* ; résolu par
 * gradient projeté avec pénalités. Produit aussi la frontière efficiente et la faisabilité.
 */
import { solve } from "./linalg.js";

export interface Asset {
  symbol: string;
  sector: string;
  expectedReturn: number; // annuel, décimal (0.12 = 12 %)
  dividendYield: number; // décimal
  price: number;
}

export interface Constraints {
  maxWeight: number; // par ligne, décimal
  maxSectorWeight: number;
  maxLines: number;
  investedMax: number; // part max investie (1 - réserve de liquidités)
  excludedSymbols?: string[];
  excludedSectors?: string[];
}

export interface OptimizationResult {
  weights: { symbol: string; weight: number }[];
  expectedReturn: number; // annuel décimal (sur le capital total, liquidités à rf)
  volatility: number; // annuelle décimale
  sharpe: number;
  dividendYield: number;
  invested: number;
  feasible: boolean;
  reachedTarget: boolean;
  maxAchievableReturn: number;
  minVolatility: number;
  frontier: { targetReturn: number; volatility: number; expectedReturn: number }[];
  notes: string[];
}

/** Covariance annualisée avec rétrécissement (Ledoit-Wolf simplifié vers la diagonale). */
export function shrinkCovariance(returns: number[][], delta = 0.3, periodsPerYear = 252): number[][] {
  const k = returns.length;
  const n = Math.min(...returns.map((r) => r.length));
  const means = returns.map((r) => r.slice(-n).reduce((a, b) => a + b, 0) / n);
  const cov = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++) for (let j = i; j < k; j++) {
    let s = 0;
    const ri = returns[i].slice(-n);
    const rj = returns[j].slice(-n);
    for (let t = 0; t < n; t++) s += (ri[t] - means[i]) * (rj[t] - means[j]);
    const c = (s / Math.max(1, n - 1)) * periodsPerYear;
    cov[i][j] = c;
    cov[j][i] = c;
  }
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) if (i !== j) cov[i][j] *= 1 - delta;
  return cov;
}

function portfolioStats(w: number[], mu: number[], cov: number[][], rf: number) {
  const invested = w.reduce((a, b) => a + b, 0);
  const ret = w.reduce((a, wi, i) => a + wi * mu[i], 0) + (1 - invested) * rf;
  let v = 0;
  for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) v += w[i] * cov[i][j] * w[j];
  return { ret, vol: Math.sqrt(Math.max(0, v)), invested };
}

/**
 * Projection sur { 0 ≤ w ≤ maxW, Σw = investedMax, secteurs ≤ maxSector } : la part investie est
 * fixée (la réserve de liquidités est décidée en amont), l'optimiseur ne joue que sur la composition.
 * Remplissage itératif (« water-filling ») : l'écart à la cible est réparti entre les lignes qui ont de la marge.
 */
function project(w: number[], assets: Asset[], c: Constraints): number[] {
  const out = w.map((x) => Math.max(0, Math.min(c.maxWeight, x)));
  const sectors = new Map<string, number[]>();
  assets.forEach((a, i) => sectors.set(a.sector, [...(sectors.get(a.sector) ?? []), i]));
  for (let it = 0; it < 30; it++) {
    for (const idxs of sectors.values()) {
      const s = idxs.reduce((a, i) => a + out[i], 0);
      if (s > c.maxSectorWeight) for (const i of idxs) out[i] *= c.maxSectorWeight / s;
    }
    const total = out.reduce((a, b) => a + b, 0);
    const gap = c.investedMax - total;
    if (Math.abs(gap) < 1e-6) break;
    const sectorRoom = (i: number) => {
      const idxs = sectors.get(assets[i].sector)!;
      return c.maxSectorWeight - idxs.reduce((a, k) => a + out[k], 0);
    };
    const candidates = out.map((x, i) => i).filter((i) => (gap > 0 ? out[i] < c.maxWeight - 1e-9 && sectorRoom(i) > 1e-9 : out[i] > 1e-9));
    if (!candidates.length) break;
    const share = gap / candidates.length;
    for (const i of candidates) out[i] = Math.max(0, Math.min(c.maxWeight, out[i] + (gap > 0 ? Math.min(share, sectorRoom(i)) : share)));
  }
  return out;
}

function optimizeFor(targetReturn: number, assets: Asset[], mu: number[], cov: number[][], c: Constraints, rf: number, iters = 1500): number[] {
  const k = assets.length;
  let w = new Array<number>(k).fill(c.investedMax / k);
  w = project(w, assets, c);
  const rho = 50; // pénalité sur le rendement cible
  const lr = 0.02;
  for (let it = 0; it < iters; it++) {
    const { ret } = portfolioStats(w, mu, cov, rf);
    const shortfall = Math.max(0, targetReturn - ret);
    const grad = w.map((_, i) => {
      let g = 0;
      for (let j = 0; j < k; j++) g += 2 * cov[i][j] * w[j];
      g -= 2 * rho * shortfall * (mu[i] - rf);
      return g;
    });
    const step = lr / (1 + it / 300);
    w = project(w.map((wi, i) => wi - step * grad[i]), assets, c);
  }
  return w;
}

/** Rendement maximal atteignable sous contraintes (remplissage glouton par rendement décroissant). */
function maxReturn(assets: Asset[], mu: number[], c: Constraints, rf: number): number {
  const order = assets.map((a, i) => i).sort((i, j) => mu[j] - mu[i]);
  const w = new Array<number>(assets.length).fill(0);
  const sectorUsed = new Map<string, number>();
  let left = c.investedMax;
  let lines = 0;
  for (const i of order) {
    if (left <= 0 || lines >= c.maxLines) break;
    const sec = assets[i].sector;
    const room = Math.min(c.maxWeight, left, c.maxSectorWeight - (sectorUsed.get(sec) ?? 0));
    if (room <= 0) continue;
    w[i] = room;
    left -= room;
    sectorUsed.set(sec, (sectorUsed.get(sec) ?? 0) + room);
    lines++;
  }
  return w.reduce((a, wi, i) => a + wi * mu[i], 0) + left * rf;
}

export function optimize(allAssets: Asset[], returnsBySymbol: Map<string, number[]>, constraints: Constraints, targetReturn: number | null, riskFree = 0.05): OptimizationResult {
  const notes: string[] = [];
  const assets = allAssets.filter((a) => !constraints.excludedSymbols?.includes(a.symbol) && !constraints.excludedSectors?.includes(a.sector) && returnsBySymbol.has(a.symbol));
  if (assets.length < 2) {
    return { weights: [], expectedReturn: riskFree, volatility: 0, sharpe: 0, dividendYield: 0, invested: 0, feasible: false, reachedTarget: false, maxAchievableReturn: riskFree, minVolatility: 0, frontier: [], notes: ["Pas assez de valeurs éligibles après application des contraintes."] };
  }
  if (constraints.maxLines * constraints.maxWeight < constraints.investedMax - 1e-9) {
    const w = Math.ceil((constraints.investedMax / constraints.maxLines) * 100) / 100;
    notes.push(`${constraints.maxLines} lignes à ${Math.round(constraints.maxWeight * 100)} % max. ne permettent pas d'investir ${Math.round(constraints.investedMax * 100)} % : poids maximal relevé à ${Math.round(w * 100)} %.`);
    constraints = { ...constraints, maxWeight: w };
  }
  const nSectors = new Set(assets.map((a) => a.sector)).size;
  if (nSectors * constraints.maxSectorWeight < constraints.investedMax - 1e-9) {
    constraints = { ...constraints, maxSectorWeight: Math.min(1, constraints.investedMax / nSectors + 0.01) };
    notes.push(`Peu de secteurs éligibles : plafond sectoriel relevé à ${Math.round(constraints.maxSectorWeight * 100)} %.`);
  }
  const mu = assets.map((a) => a.expectedReturn);
  const cov = shrinkCovariance(assets.map((a) => returnsBySymbol.get(a.symbol)!));
  const maxAch = maxReturn(assets, mu, constraints, riskFree);
  const minVolW = optimizeFor(-1, assets, mu, cov, constraints, riskFree, 800);
  const minVol = portfolioStats(minVolW, mu, cov, riskFree);

  let target = targetReturn ?? maxAch * 0.7;
  let reachedTarget = true;
  if (targetReturn !== null && targetReturn > maxAch) {
    notes.push(`Rendement visé ${(targetReturn * 100).toFixed(1)} % supérieur au maximum atteignable sous vos contraintes (${(maxAch * 100).toFixed(1)} %) : l'allocation vise ce maximum.`);
    target = maxAch;
    reachedTarget = false;
  }
  let w = optimizeFor(target, assets, mu, cov, constraints, riskFree);
  // limitation du nombre de lignes : conserver les plus pondérées puis réoptimiser sur ce sous-ensemble
  const nonZero = w.map((x, i) => ({ x, i })).filter((e) => e.x > 0.005).sort((a, b) => b.x - a.x);
  if (nonZero.length > constraints.maxLines) {
    const keep = new Set(nonZero.slice(0, constraints.maxLines).map((e) => e.i));
    const sub = assets.filter((_, i) => keep.has(i));
    const subMu = sub.map((a) => a.expectedReturn);
    const subCov = shrinkCovariance(sub.map((a) => returnsBySymbol.get(a.symbol)!));
    const subW = optimizeFor(target, sub, subMu, subCov, constraints, riskFree);
    w = assets.map((a) => {
      const j = sub.findIndex((s) => s.symbol === a.symbol);
      return j >= 0 ? subW[j] : 0;
    });
  }
  w = w.map((x) => (x < 0.005 ? 0 : x));
  const stats = portfolioStats(w, mu, cov, riskFree);
  if (targetReturn !== null && stats.ret < targetReturn - 0.005) reachedTarget = false;
  const dividendYield = w.reduce((a, wi, i) => a + wi * assets[i].dividendYield, 0);

  // Frontière efficiente : 6 points entre variance minimale et rendement maximal
  const frontier: OptimizationResult["frontier"] = [];
  const lo = minVol.ret;
  const hi = maxAch;
  for (let s = 0; s <= 5; s++) {
    const tr = lo + ((hi - lo) * s) / 5;
    const fw = optimizeFor(tr, assets, mu, cov, constraints, riskFree, 500);
    const st = portfolioStats(fw, mu, cov, riskFree);
    frontier.push({ targetReturn: round4(tr), volatility: round4(st.vol), expectedReturn: round4(st.ret) });
  }

  return {
    weights: assets.map((a, i) => ({ symbol: a.symbol, weight: round4(w[i]) })).filter((x) => x.weight > 0).sort((a, b) => b.weight - a.weight),
    expectedReturn: round4(stats.ret),
    volatility: round4(stats.vol),
    sharpe: stats.vol > 0 ? Math.round(((stats.ret - riskFree) / stats.vol) * 100) / 100 : 0,
    dividendYield: round4(dividendYield),
    invested: round4(stats.invested),
    feasible: true,
    reachedTarget,
    maxAchievableReturn: round4(maxAch),
    minVolatility: round4(minVol.vol),
    frontier,
    notes,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export { solve };
