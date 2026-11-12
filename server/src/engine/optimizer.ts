/**
 * Optimiseur de portefeuille (moyenne-variance sous contraintes).
 *
 * Entrées : rendements annuels attendus par valeur (prévision + dividende), matrice de covariance
 * annualisée des rendements (rétrécie vers la diagonale, ou structurée par un modèle factoriel),
 * contraintes (poids max par ligne — profil et liquidité —, par secteur, exclusions, nombre de lignes
 * max, part investie max, limite de CVaR, coûts de rotation depuis un portefeuille existant).
 * Objectif : pour un rendement cible r*, minimiser la variance sous μ'w − coûts ≥ r* ; résolu par
 * gradient projeté avec pénalités. Produit aussi la frontière efficiente et la faisabilité.
 */
import { solve } from "./linalg.js";
import { lossMeasures } from "./riskmodel.js";

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
  /** plafonds par valeur (liquidité), décimal ; combinés au poids max par ligne */
  maxWeightBySymbol?: Record<string, number>;
  /** limite de CVaR historique à un mois (décimal, perte) ; l'allocation est ramenée vers la variance minimale si elle la dépasse */
  cvarLimit?: number;
  /** coûts de rotation : poids actuels, coût d'un sens (décimal) amorti sur l'horizon (années) */
  turnover?: { current: Record<string, number>; costPerSide: number; horizonYears: number };
}

export interface OptimizeOptions {
  /** covariance annualisée fournie (modèle factoriel), indexée par symbole */
  covariance?: { symbols: string[]; matrix: number[][] };
}

export interface OptimizationResult {
  weights: { symbol: string; weight: number }[];
  expectedReturn: number; // annuel décimal (sur le capital total, liquidités à rf), brut de coûts
  /** rendement net des coûts de rotation amortis */
  netExpectedReturn: number;
  /** coûts de rotation annualisés (décimal) */
  costDrag: number;
  /** rotation : Σ|w − w0| (décimal, un sens) */
  turnover: number;
  volatility: number; // annuelle décimale
  sharpe: number;
  dividendYield: number;
  invested: number;
  feasible: boolean;
  reachedTarget: boolean;
  maxAchievableReturn: number;
  minVolatility: number;
  frontier: { targetReturn: number; volatility: number; expectedReturn: number }[];
  /** CVaR 95 % à un mois, VaR et perte maximale historiques de l'allocation */
  loss: { cvar: number; var: number; maxDrawdown: number; limit: number | null; limited: boolean };
  /** valeurs dont le poids est plafonné par la liquidité */
  liquidityCapped: { symbol: string; cap: number }[];
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

interface Problem {
  assets: Asset[];
  mu: number[];
  cov: number[][];
  caps: number[]; // plafond par valeur
  c: Constraints;
  rf: number;
  w0: number[]; // poids actuels (0 sans portefeuille existant)
  costRate: number; // coût d'un sens amorti par an
}

function portfolioStats(w: number[], p: Problem) {
  const invested = w.reduce((a, b) => a + b, 0);
  const ret = w.reduce((a, wi, i) => a + wi * p.mu[i], 0) + (1 - invested) * p.rf;
  let v = 0;
  for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) v += w[i] * p.cov[i][j] * w[j];
  const turnover = w.reduce((a, wi, i) => a + Math.abs(wi - p.w0[i]), 0);
  const cost = turnover * p.costRate;
  return { ret, net: ret - cost, cost, turnover, vol: Math.sqrt(Math.max(0, v)), invested };
}

/**
 * Projection sur { 0 ≤ w ≤ cap_i, Σw = investedMax, secteurs ≤ maxSector } : la part investie est
 * fixée (la réserve de liquidités est décidée en amont), l'optimiseur ne joue que sur la composition.
 * Remplissage itératif (« water-filling ») : l'écart à la cible est réparti entre les lignes qui ont de la marge.
 */
function project(w: number[], p: Problem): number[] {
  const { assets, c, caps } = p;
  const out = w.map((x, i) => Math.max(0, Math.min(caps[i], x)));
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
    const candidates = out.map((x, i) => i).filter((i) => (gap > 0 ? out[i] < caps[i] - 1e-9 && sectorRoom(i) > 1e-9 : out[i] > 1e-9));
    if (!candidates.length) break;
    const share = gap / candidates.length;
    for (const i of candidates) out[i] = Math.max(0, Math.min(caps[i], out[i] + (gap > 0 ? Math.min(share, sectorRoom(i)) : share)));
  }
  return out;
}

function optimizeFor(targetReturn: number, p: Problem, iters = 1500): number[] {
  const k = p.assets.length;
  let w = new Array<number>(k).fill(p.c.investedMax / k);
  w = project(w, p);
  const rho = 50; // pénalité sur le rendement cible
  const lr = 0.02;
  for (let it = 0; it < iters; it++) {
    const { net } = portfolioStats(w, p);
    const shortfall = Math.max(0, targetReturn - net);
    const grad = w.map((_, i) => {
      let g = 0;
      for (let j = 0; j < k; j++) g += 2 * p.cov[i][j] * w[j];
      // le rendement net baisse de costRate par unité de poids éloignée du portefeuille actuel (lissé)
      const dCost = p.costRate * Math.tanh((w[i] - p.w0[i]) / 0.005);
      g -= 2 * rho * shortfall * (p.mu[i] - p.rf - dCost);
      return g;
    });
    const step = lr / (1 + it / 300);
    w = project(w.map((wi, i) => wi - step * grad[i]), p);
  }
  return w;
}

/** Rendement maximal atteignable sous contraintes (remplissage glouton par rendement décroissant), net des coûts. */
function maxReturn(p: Problem): number {
  const { assets, mu, c, caps, rf } = p;
  const order = assets.map((a, i) => i).sort((i, j) => mu[j] - mu[i]);
  const w = new Array<number>(assets.length).fill(0);
  const sectorUsed = new Map<string, number>();
  let left = c.investedMax;
  let lines = 0;
  for (const i of order) {
    if (left <= 0 || lines >= c.maxLines) break;
    const sec = assets[i].sector;
    const room = Math.min(caps[i], left, c.maxSectorWeight - (sectorUsed.get(sec) ?? 0));
    if (room <= 0) continue;
    w[i] = room;
    left -= room;
    sectorUsed.set(sec, (sectorUsed.get(sec) ?? 0) + room);
    lines++;
  }
  return portfolioStats(w, p).net;
}

function subMatrix(symbols: string[], cov: { symbols: string[]; matrix: number[][] }): number[][] | null {
  const pos = new Map(cov.symbols.map((s, i) => [s, i]));
  if (symbols.some((s) => !pos.has(s))) return null;
  return symbols.map((a) => symbols.map((b) => cov.matrix[pos.get(a)!][pos.get(b)!]));
}

export function optimize(allAssets: Asset[], returnsBySymbol: Map<string, number[]>, constraints: Constraints, targetReturn: number | null, riskFree = 0.05, options: OptimizeOptions = {}): OptimizationResult {
  const notes: string[] = [];
  const assets = allAssets.filter((a) => !constraints.excludedSymbols?.includes(a.symbol) && !constraints.excludedSectors?.includes(a.sector) && returnsBySymbol.has(a.symbol));
  const empty = (): OptimizationResult => ({ weights: [], expectedReturn: riskFree, netExpectedReturn: riskFree, costDrag: 0, turnover: 0, volatility: 0, sharpe: 0, dividendYield: 0, invested: 0, feasible: false, reachedTarget: false, maxAchievableReturn: riskFree, minVolatility: 0, frontier: [], loss: { cvar: 0, var: 0, maxDrawdown: 0, limit: constraints.cvarLimit ?? null, limited: false }, liquidityCapped: [], notes: ["Pas assez de valeurs éligibles après application des contraintes."] });
  if (assets.length < 2) return empty();
  let c = { ...constraints };
  if (c.maxLines * c.maxWeight < c.investedMax - 1e-9) {
    const w = Math.ceil((c.investedMax / c.maxLines) * 100) / 100;
    notes.push(`${c.maxLines} lignes à ${Math.round(c.maxWeight * 100)} % max. ne permettent pas d'investir ${Math.round(c.investedMax * 100)} % : poids maximal relevé à ${Math.round(w * 100)} %.`);
    c = { ...c, maxWeight: w };
  }
  const nSectors = new Set(assets.map((a) => a.sector)).size;
  if (nSectors * c.maxSectorWeight < c.investedMax - 1e-9) {
    c = { ...c, maxSectorWeight: Math.min(1, c.investedMax / nSectors + 0.01) };
    notes.push(`Peu de secteurs éligibles : plafond sectoriel relevé à ${Math.round(c.maxSectorWeight * 100)} %.`);
  }
  // plafonds par valeur : profil et liquidité
  const liquidityCapped: OptimizationResult["liquidityCapped"] = [];
  const caps = assets.map((a) => {
    const liq = c.maxWeightBySymbol?.[a.symbol];
    if (liq != null && liq < c.maxWeight) liquidityCapped.push({ symbol: a.symbol, cap: Math.round(liq * 1000) / 1000 });
    return Math.max(0, Math.min(c.maxWeight, liq ?? 1));
  });
  const capSum = caps.reduce((a, b) => a + b, 0);
  if (capSum < c.investedMax - 1e-9) {
    notes.push(`La liquidité des valeurs éligibles ne permet pas d'investir ${Math.round(c.investedMax * 100)} % du capital sans peser sur le marché : part investie ramenée à ${Math.round(capSum * 100)} %.`);
    c = { ...c, investedMax: Math.max(0, capSum - 1e-6) };
  }
  const mu = assets.map((a) => a.expectedReturn);
  const provided = options.covariance ? subMatrix(assets.map((a) => a.symbol), options.covariance) : null;
  const cov = provided ?? shrinkCovariance(assets.map((a) => returnsBySymbol.get(a.symbol)!));
  const w0 = assets.map((a) => c.turnover?.current[a.symbol] ?? 0);
  const costRate = c.turnover ? c.turnover.costPerSide / Math.max(0.25, c.turnover.horizonYears) : 0;
  const p: Problem = { assets, mu, cov, caps, c, rf: riskFree, w0, costRate };
  const returns = assets.map((a) => returnsBySymbol.get(a.symbol)!);

  const maxAch = maxReturn(p);
  const minVolW = optimizeFor(-1, p, 800);
  const minVol = portfolioStats(minVolW, p);

  let target = targetReturn ?? maxAch * 0.7;
  let reachedTarget = true;
  if (targetReturn !== null && targetReturn > maxAch) {
    notes.push(`Rendement visé ${(targetReturn * 100).toFixed(1)} % supérieur au maximum atteignable sous vos contraintes (${(maxAch * 100).toFixed(1)} %) : l'allocation vise ce maximum.`);
    target = maxAch;
    reachedTarget = false;
  }
  let w = optimizeFor(target, p);
  // limitation du nombre de lignes : conserver les plus pondérées puis réoptimiser sur ce sous-ensemble
  const nonZero = w.map((x, i) => ({ x, i })).filter((e) => e.x > 0.005).sort((a, b) => b.x - a.x);
  if (nonZero.length > c.maxLines) {
    const keep = new Set(nonZero.slice(0, c.maxLines).map((e) => e.i));
    const idx = assets.map((_, i) => i).filter((i) => keep.has(i));
    const sub: Problem = { ...p, assets: idx.map((i) => assets[i]), mu: idx.map((i) => mu[i]), cov: idx.map((i) => idx.map((j) => cov[i][j])), caps: idx.map((i) => caps[i]), w0: idx.map((i) => w0[i]) };
    const subW = optimizeFor(target, sub);
    w = assets.map((_, i) => { const j = idx.indexOf(i); return j >= 0 ? subW[j] : 0; });
  }
  w = w.map((x) => (x < 0.005 ? 0 : x));

  // limite de perte : CVaR historique à un mois ; si dépassée, combinaison avec le portefeuille de variance minimale
  let limited = false;
  let loss = lossMeasures(w, returns);
  if (c.cvarLimit != null && loss.cvar > c.cvarLimit) {
    const minLoss = lossMeasures(minVolW, returns);
    if (minLoss.cvar <= c.cvarLimit) {
      let lo = 0; // part du portefeuille cible (0 = variance minimale)
      let hi = 1;
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) / 2;
        const wm = w.map((x, i) => mid * x + (1 - mid) * minVolW[i]);
        if (lossMeasures(wm, returns).cvar <= c.cvarLimit) lo = mid; else hi = mid;
      }
      w = w.map((x, i) => lo * x + (1 - lo) * minVolW[i]).map((x) => (x < 0.005 ? 0 : x));
      loss = lossMeasures(w, returns);
      limited = true;
      reachedTarget = false;
      notes.push(`Limite de perte : la CVaR à un mois dépassait ${(c.cvarLimit * 100).toFixed(0)} % ; l'allocation est ramenée vers le portefeuille de variance minimale (${Math.round((1 - lo) * 100)} %).`);
    } else {
      notes.push(`Limite de perte de ${(c.cvarLimit * 100).toFixed(0)} % (CVaR à un mois) inatteignable avec ces valeurs : même le portefeuille le moins volatil l'atteint à ${(minLoss.cvar * 100).toFixed(1)} %. Réduisez la part investie ou renforcez la poche obligataire.`);
    }
  }
  const stats = portfolioStats(w, p);
  if (targetReturn !== null && stats.net < targetReturn - 0.005) reachedTarget = false;
  const dividendYield = w.reduce((a, wi, i) => a + wi * assets[i].dividendYield, 0);

  // Frontière efficiente : 6 points entre variance minimale et rendement maximal
  const frontier: OptimizationResult["frontier"] = [];
  const lo = minVol.net;
  const hi = maxAch;
  for (let s = 0; s <= 5; s++) {
    const tr = lo + ((hi - lo) * s) / 5;
    const fw = optimizeFor(tr, p, 500);
    const st = portfolioStats(fw, p);
    frontier.push({ targetReturn: round4(tr), volatility: round4(st.vol), expectedReturn: round4(st.net) });
  }

  return {
    weights: assets.map((a, i) => ({ symbol: a.symbol, weight: round4(w[i]) })).filter((x) => x.weight > 0).sort((a, b) => b.weight - a.weight),
    expectedReturn: round4(stats.ret),
    netExpectedReturn: round4(stats.net),
    costDrag: round4(stats.cost),
    turnover: round4(stats.turnover),
    volatility: round4(stats.vol),
    sharpe: stats.vol > 0 ? Math.round(((stats.net - riskFree) / stats.vol) * 100) / 100 : 0,
    dividendYield: round4(dividendYield),
    invested: round4(stats.invested),
    feasible: true,
    reachedTarget,
    maxAchievableReturn: round4(maxAch),
    minVolatility: round4(minVol.vol),
    frontier,
    loss: { cvar: loss.cvar, var: loss.var, maxDrawdown: loss.maxDrawdown, limit: c.cvarLimit ?? null, limited },
    liquidityCapped,
    notes,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export { solve };
