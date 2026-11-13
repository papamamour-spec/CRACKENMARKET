/**
 * Attribution de performance.
 *
 * D'où vient la performance d'un portefeuille sur une période, ligne par ligne et par rapport à une
 * référence (le BRVM Composite reconstitué) ? Méthode de Brinson-Fachler sur une période, en
 * « achat-conservation » : les quantités sont fixes, les poids dérivent avec les cours.
 *
 *   contribution_i = w_i × R_i                          (Σ = rendement de la poche investie)
 *   allocation_s   = (w_p,s − w_b,s) × (R_b,s − R_b)      (bon ou mauvais choix de secteur)
 *   sélection_s    = w_b,s × (R_p,s − R_b,s)              (bon ou mauvais choix de titres dans le secteur)
 *   interaction_s  = (w_p,s − w_b,s) × (R_p,s − R_b,s)
 *   Σ_s (allocation + sélection + interaction) = R_p,investi − R_b
 *
 * S'y ajoutent, exactement : l'effet des liquidités (poche non investie, qui ne rapporte ni ne perd),
 * l'effet des coûts (frais d'entrée et de sortie), et la part des dividendes dans le rendement de chaque
 * ligne (écart entre série ajustée et série cotée). L'exposition au marché (bêta) sépare ce qui vient de
 * la place de ce qui est propre au portefeuille.
 */

export interface AttributionLineInput {
  symbol: string;
  sector: string;
  /** poids de départ sur la valeur totale (liquidités comprises), décimal */
  weight: number;
  /** rendement total de la ligne sur la période (série ajustée), décimal */
  totalReturn: number;
  /** rendement de cours seul (série cotée), décimal ; null si inconnu */
  priceReturn: number | null;
  /** rendements quotidiens (log) de la ligne sur la période, pour le bêta */
  daily?: number[];
}

export interface BenchmarkInput {
  /** poids de la référence par valeur au départ (décimal, Σ = 1) */
  weights: Map<string, number>;
  /** rendement total de chaque valeur de la référence sur la période (décimal) */
  returns: Map<string, number>;
  sectors: Map<string, string>;
  /** rendements quotidiens (log) de l'indice, pour le bêta */
  daily?: number[];
}

export interface SectorEffect {
  sector: string;
  weightPortfolioPct: number;
  weightBenchmarkPct: number;
  returnPortfolioPct: number | null;
  returnBenchmarkPct: number | null;
  allocationPct: number;
  selectionPct: number;
  interactionPct: number;
  totalPct: number;
}

export interface AttributionResult {
  /** rendement brut de la valeur totale (liquidités comprises), décimal */
  portfolioReturn: number;
  investedReturn: number;
  benchmarkReturn: number;
  activeReturn: number;
  investedWeight: number;
  effects: { allocation: number; selection: number; interaction: number; cash: number; costs: number; dividends: number };
  sectors: SectorEffect[];
  lines: { symbol: string; sector: string; weightStartPct: number; weightEndPct: number; returnPct: number; priceReturnPct: number | null; dividendPct: number | null; contributionPct: number; benchmarkWeightPct: number; activeWeightPct: number }[];
  factors: { beta: number | null; marketContribution: number | null; specific: number | null };
}

const r2 = (v: number) => Math.round(v * 10000) / 100;

function beta(p: number[], m: number[]): number | null {
  const n = Math.min(p.length, m.length);
  if (n < 15) return null;
  const a = p.slice(-n);
  const b = m.slice(-n);
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let cv = 0;
  let vb = 0;
  for (let t = 0; t < n; t++) { cv += (a[t] - ma) * (b[t] - mb); vb += (b[t] - mb) ** 2; }
  return vb > 0 ? Math.round((cv / vb) * 100) / 100 : null;
}

export function attribute(lines: AttributionLineInput[], bench: BenchmarkInput, opts: { costRate?: number } = {}): AttributionResult {
  const investedWeight = lines.reduce((a, l) => a + l.weight, 0);
  const investedReturn = investedWeight > 0 ? lines.reduce((a, l) => a + l.weight * l.totalReturn, 0) / investedWeight : 0;
  const portfolioReturn = lines.reduce((a, l) => a + l.weight * l.totalReturn, 0); // la poche non investie rapporte 0
  const benchmarkReturn = [...bench.weights.entries()].reduce((a, [s, w]) => a + w * (bench.returns.get(s) ?? 0), 0);

  // secteurs : poids et rendements pondérés, côté portefeuille (poche investie normalisée) et côté référence
  const sectorsSet = new Set<string>([...lines.map((l) => l.sector), ...[...bench.weights.keys()].map((s) => bench.sectors.get(s) ?? "?")]);
  const sectors: SectorEffect[] = [];
  let allocation = 0;
  let selection = 0;
  let interaction = 0;
  for (const sector of sectorsSet) {
    // poids du portefeuille sur la valeur totale (non normalisés) : Σ effets = R_p − w_investi × R_b,
    // et l'effet des liquidités −(1 − w_investi) × R_b complète exactement l'écart à l'indice
    const pl = lines.filter((l) => l.sector === sector);
    const wp = pl.reduce((a, l) => a + l.weight, 0);
    const rp = wp > 0 ? pl.reduce((a, l) => a + l.weight * l.totalReturn, 0) / wp : null;
    const bs = [...bench.weights.entries()].filter(([s]) => (bench.sectors.get(s) ?? "?") === sector);
    const wb = bs.reduce((a, [, w]) => a + w, 0);
    const rb = wb > 0 ? bs.reduce((a, [s, w]) => a + w * (bench.returns.get(s) ?? 0), 0) / wb : null;
    const rbEff = rb ?? benchmarkReturn;
    const rpEff = rp ?? rbEff;
    const alloc = (wp - wb) * (rbEff - benchmarkReturn);
    const sel = wb * (rpEff - rbEff);
    const inter = (wp - wb) * (rpEff - rbEff);
    allocation += alloc;
    selection += sel;
    interaction += inter;
    sectors.push({ sector, weightPortfolioPct: r2(wp), weightBenchmarkPct: r2(wb), returnPortfolioPct: rp != null ? r2(rp) : null, returnBenchmarkPct: rb != null ? r2(rb) : null, allocationPct: r2(alloc), selectionPct: r2(sel), interactionPct: r2(inter), totalPct: r2(alloc + sel + inter) });
  }
  sectors.sort((a, b) => Math.abs(b.totalPct) - Math.abs(a.totalPct));

  // liquidités : la part non investie ne suit pas la référence
  const cash = -(1 - investedWeight) * benchmarkReturn;
  const costs = -(opts.costRate ?? 0);
  const dividends = lines.reduce((a, l) => a + (l.priceReturn != null ? l.weight * (l.totalReturn - l.priceReturn) : 0), 0);

  const endValue = 1 + portfolioReturn;
  const out: AttributionResult = {
    portfolioReturn,
    investedReturn,
    benchmarkReturn,
    activeReturn: portfolioReturn - benchmarkReturn,
    investedWeight,
    effects: { allocation, selection, interaction, cash, costs, dividends },
    sectors,
    lines: lines.map((l) => ({
      symbol: l.symbol,
      sector: l.sector,
      weightStartPct: r2(l.weight),
      weightEndPct: r2(endValue > 0 ? (l.weight * (1 + l.totalReturn)) / endValue : 0),
      returnPct: r2(l.totalReturn),
      priceReturnPct: l.priceReturn != null ? r2(l.priceReturn) : null,
      dividendPct: l.priceReturn != null ? r2(l.totalReturn - l.priceReturn) : null,
      contributionPct: r2(l.weight * l.totalReturn),
      benchmarkWeightPct: r2(bench.weights.get(l.symbol) ?? 0),
      activeWeightPct: r2(l.weight - (bench.weights.get(l.symbol) ?? 0)),
    })).sort((a, b) => b.contributionPct - a.contributionPct),
    factors: { beta: null, marketContribution: null, specific: null },
  };
  // exposition au marché : bêta de la série quotidienne du portefeuille contre l'indice
  if (bench.daily && lines.every((l) => l.daily && l.daily.length >= 15)) {
    const n = Math.min(bench.daily.length, ...lines.map((l) => l.daily!.length));
    const port = Array.from({ length: n }, (_, t) => lines.reduce((a, l) => a + l.weight * l.daily![l.daily!.length - n + t], 0));
    const b = beta(port, bench.daily.slice(-n));
    if (b != null) out.factors = { beta: b, marketContribution: b * benchmarkReturn, specific: portfolioReturn - b * benchmarkReturn };
  }
  return out;
}
