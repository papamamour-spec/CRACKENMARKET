/**
 * Black-Litterman : rendements attendus robustes pour l'optimiseur.
 *
 * Une optimisation moyenne-variance nourrie de prévisions bruitées produit des allocations extrêmes.
 * Black-Litterman part de l'équilibre du marché (les rendements implicites des pondérations par
 * capitalisation, Π = rf + δ Σ w) et n'en dévie qu'en proportion de la confiance accordée à chaque
 * vue (ici, une vue absolue par valeur : la prévision du moteur). Avec P = I :
 *   μ = Π + τΣ (τΣ + Ω)⁻¹ (Q − Π),   Ω_ii = τ Σ_ii (1 − c_i) / c_i
 * c_i ∈ [0,05 ; 0,95] étant la confiance de la vue i. Une vue sûre tire le rendement vers la
 * prévision, une vue incertaine le laisse près de l'équilibre.
 */
import { solve } from "./linalg.js";
import { shrinkCovariance, type Asset } from "./optimizer.js";

export interface BLAsset {
  symbol: string;
  /** capitalisation (ou son proxy) servant de poids d'équilibre */
  marketCap: number;
  /** vue : rendement annuel attendu (décimal) */
  view: number;
  /** confiance dans la vue, 0 … 1 */
  confidence: number;
}

export interface BLResult {
  symbols: string[];
  marketWeights: number[];
  equilibrium: number[];
  posterior: number[];
  delta: number;
  tau: number;
  /** part de la vue retenue dans le postérieur, par valeur (0 = équilibre pur, 1 = vue pure) */
  viewShare: number[];
}

/** Inverse d'une matrice carrée (résolution colonne par colonne). */
export function inverse(a: number[][]): number[][] {
  const n = a.length;
  const cols: number[][] = [];
  for (let j = 0; j < n; j++) {
    const e = new Array<number>(n).fill(0);
    e[j] = 1;
    cols.push(solve(a.map((r) => [...r]), e));
  }
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
}

export function blackLitterman(assets: BLAsset[], cov: number[][], riskFree: number, opts: { tau?: number; delta?: number } = {}): BLResult {
  const n = assets.length;
  const tau = opts.tau ?? 0.05;
  const capSum = assets.reduce((a, x) => a + Math.max(0, x.marketCap), 0);
  const w = assets.map((x) => (capSum > 0 ? Math.max(0, x.marketCap) / capSum : 1 / n));
  // aversion au risque : rendement excédentaire du marché rapporté à sa variance (défaut 2,5)
  let delta = opts.delta ?? 2.5;
  if (opts.delta == null) {
    let varM = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) varM += w[i] * cov[i][j] * w[j];
    const premium = 0.04; // prime de risque actions supposée pour fixer l'échelle de l'équilibre
    if (varM > 0) delta = Math.max(1, Math.min(6, premium / varM));
  }
  const equilibrium = Array.from({ length: n }, (_, i) => riskFree + delta * w.reduce((a, wj, j) => a + cov[i][j] * wj, 0));
  const tauS = cov.map((r) => r.map((v) => v * tau));
  const m = tauS.map((r, i) => r.map((v, j) => (i === j ? v + tauS[i][i] * ((1 - clampConf(assets[i].confidence)) / clampConf(assets[i].confidence)) : v)));
  const inv = inverse(m);
  const diff = assets.map((x, i) => x.view - equilibrium[i]);
  const posterior = equilibrium.map((pi, i) => {
    let adj = 0;
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += tauS[i][j] * inv[j][k];
      adj += s * diff[k];
    }
    return pi + adj;
  });
  const viewShare = assets.map((x, i) => (Math.abs(diff[i]) > 1e-9 ? Math.max(0, Math.min(1, (posterior[i] - equilibrium[i]) / diff[i])) : clampConf(x.confidence)));
  return { symbols: assets.map((x) => x.symbol), marketWeights: w, equilibrium, posterior, delta: Math.round(delta * 100) / 100, tau, viewShare };
}

function clampConf(c: number): number {
  return Math.max(0.05, Math.min(0.95, Number.isFinite(c) ? c : 0.5));
}

export interface BLLine {
  symbol: string;
  marketWeightPct: number;
  equilibriumPct: number;
  viewPct: number;
  posteriorPct: number;
  confidence: number;
  viewSharePct: number;
}

export interface BLApplied {
  assets: Asset[];
  lines: BLLine[];
  delta: number;
  tau: number;
  /** valeurs sans historique suffisant : vue conservée telle quelle */
  skipped: string[];
}

/**
 * Applique Black-Litterman à l'univers de l'optimiseur : les vues sont les rendements attendus des
 * actifs, la covariance est celle (rétrécie) des rendements quotidiens, les poids d'équilibre ceux
 * des capitalisations. Renvoie les actifs avec le rendement postérieur et le détail par ligne.
 */
export function applyBlackLitterman(assets: Asset[], returnsBySymbol: Map<string, number[]>, marketCaps: Map<string, number>, confidences: Map<string, number>, riskFree: number, opts: { tau?: number; delta?: number; covariance?: { symbols: string[]; matrix: number[][] } } = {}): BLApplied {
  const usable = assets.filter((a) => (returnsBySymbol.get(a.symbol)?.length ?? 0) >= 60);
  const skipped = assets.filter((a) => !usable.includes(a)).map((a) => a.symbol);
  if (usable.length < 2) return { assets: assets.map((a) => ({ ...a })), lines: [], delta: opts.delta ?? 2.5, tau: opts.tau ?? 0.05, skipped };
  const provided = opts.covariance ? (() => { const pos = new Map(opts.covariance!.symbols.map((s, i) => [s, i])); return usable.every((a) => pos.has(a.symbol)) ? usable.map((a) => usable.map((b) => opts.covariance!.matrix[pos.get(a.symbol)!][pos.get(b.symbol)!])) : null; })() : null;
  const cov = provided ?? shrinkCovariance(usable.map((a) => returnsBySymbol.get(a.symbol)!));
  const bl = blackLitterman(usable.map((a) => ({ symbol: a.symbol, marketCap: marketCaps.get(a.symbol) ?? 0, view: a.expectedReturn, confidence: confidences.get(a.symbol) ?? 0.3 })), cov, riskFree, opts);
  const posterior = new Map(bl.symbols.map((s, i) => [s, bl.posterior[i]]));
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const lines: BLLine[] = bl.symbols.map((s, i) => ({ symbol: s, marketWeightPct: r1(bl.marketWeights[i] * 100), equilibriumPct: r1(bl.equilibrium[i] * 100), viewPct: r1(usable[i].expectedReturn * 100), posteriorPct: r1(bl.posterior[i] * 100), confidence: Math.round((confidences.get(s) ?? 0.3) * 100) / 100, viewSharePct: Math.round(bl.viewShare[i] * 100) }));
  return { assets: assets.map((a) => ({ ...a, expectedReturn: posterior.get(a.symbol) ?? a.expectedReturn })), lines, delta: bl.delta, tau: bl.tau, skipped };
}
