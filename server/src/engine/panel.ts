/**
 * Modèle de panel : une régression commune à toute la cote.
 *
 * Un modèle par valeur n'a que quelques centaines d'observations ; un modèle entraîné sur toutes
 * les valeurs en même temps en a cinquante fois plus et capte ce qui est commun à la place. Il
 * prédit le rendement **relatif** d'une valeur à l'horizon (son rendement moins la moyenne des
 * valeurs à la même date), à partir de facteurs normalisés : momentum, retour à la moyenne,
 * volatilité, RSI, volumes, pente, rangs transversaux du momentum et de la volatilité, rendement du
 * dividende, rendement bénéficiaire, détachement proche. Rien ici ne regarde l'avenir : à une date
 * d'entraînement ne sont utilisées que les données antérieures, et les variables de fondamentaux
 * sont celles connues à cette date (fournies par `extrasAt`).
 */
import { rsi, sma, slopePct, type Candle } from "./indicators.js";
import { HORIZON_DAYS, type Contribution, type Horizon } from "./forecast.js";
import { mean, ridge, stddev } from "./linalg.js";

export interface PanelExtras {
  dividendYieldPct: number | null;
  earningsYieldPct: number | null;
  /** jours civils avant le prochain détachement connu, null si inconnu */
  daysToExDividend: number | null;
}

export type ExtrasAt = (symbol: string, ts: number, price: number) => PanelExtras;

export interface PanelPrediction {
  /** rendement relatif attendu (points de %, par rapport à la moyenne des valeurs) */
  relPct: number;
  contributions: Contribution[];
}

export interface PanelHorizonStats {
  horizon: Horizon;
  samples: number;
  testSamples: number;
  /** erreur absolue moyenne (points de %) sur les 30 % d'observations les plus récentes, et celle de la prévision nulle */
  testMaePct: number | null;
  naiveMaePct: number | null;
  /** taux de bonne direction du rendement relatif en test */
  hitRate: number | null;
  lambda: number;
}

export interface PanelResult {
  asOf: number;
  symbols: number;
  predictions: Map<string, Partial<Record<Horizon, PanelPrediction>>>;
  stats: PanelHorizonStats[];
}

export const PANEL_FACTORS: { key: string; label: string; fmt: (v: number) => string }[] = [
  { key: "mom21", label: "Momentum 1 mois", fmt: (v) => `${(v * 100).toFixed(1)} %` },
  { key: "mom63", label: "Momentum 3 mois", fmt: (v) => `${(v * 100).toFixed(1)} %` },
  { key: "rev50", label: "Écart à la moyenne 50 séances", fmt: (v) => `${(v * 100).toFixed(1)} %` },
  { key: "vol20", label: "Volatilité 20 séances", fmt: (v) => `${(v * 100).toFixed(0)} % ann.` },
  { key: "rsi", label: "RSI 14", fmt: (v) => `${(50 + v * 50).toFixed(0)}` },
  { key: "volRatio", label: "Volumes 5 / 60 séances", fmt: (v) => `×${(1 + v).toFixed(2)}` },
  { key: "slope20", label: "Pente 20 séances", fmt: (v) => `${v.toFixed(2)} %/séance` },
  { key: "rankMom21", label: "Rang du momentum 1 mois sur la cote", fmt: (v) => `${Math.round((v + 0.5) * 100)}e centile` },
  { key: "rankMom63", label: "Rang du momentum 3 mois sur la cote", fmt: (v) => `${Math.round((v + 0.5) * 100)}e centile` },
  { key: "rankVol", label: "Rang de la volatilité sur la cote", fmt: (v) => `${Math.round((v + 0.5) * 100)}e centile` },
  { key: "divYield", label: "Rendement du dividende", fmt: (v) => `${v.toFixed(1)} %` },
  { key: "earnYield", label: "Rendement bénéficiaire (1 / PER)", fmt: (v) => `${v.toFixed(1)} %` },
  { key: "exSoon", label: "Détachement de dividende sous 30 jours", fmt: (v) => (v > 0 ? "oui" : "non") },
];

interface Prepared {
  symbol: string;
  candles: Candle[];
  closes: number[];
  vols: number[];
  sma50: number[];
  rsi14: number[];
  byTs: Map<number, number>;
}

function prepare(symbol: string, candles: Candle[]): Prepared {
  const closes = candles.map((c) => c.close);
  return { symbol, candles, closes, vols: candles.map((c) => c.volume), sma50: sma(closes, 50), rsi14: rsi(closes, 14), byTs: new Map(candles.map((c, i) => [c.ts, i])) };
}

function rawFeatures(p: Prepared, t: number): number[] | null {
  if (t < 70) return null;
  const c = p.closes[t];
  const mom21 = Math.log(c / p.closes[t - 21]);
  const mom63 = Math.log(c / p.closes[t - 63]);
  const rev50 = Number.isFinite(p.sma50[t]) && p.sma50[t] > 0 ? c / p.sma50[t] - 1 : 0;
  const lr: number[] = [];
  for (let i = t - 19; i <= t; i++) lr.push(Math.log(p.closes[i] / p.closes[i - 1]));
  const vol20 = stddev(lr) * Math.sqrt(252);
  const rsiN = Number.isFinite(p.rsi14[t]) ? (p.rsi14[t] - 50) / 50 : 0;
  const v5 = mean(p.vols.slice(t - 4, t + 1));
  const v60 = mean(p.vols.slice(t - 59, t + 1)) || 1;
  const volRatio = Math.max(-1, Math.min(3, v5 / v60 - 1));
  const slope20 = slopePct(p.closes.slice(t - 19, t + 1));
  return [mom21, mom63, rev50, vol20, rsiN, volRatio, slope20];
}

/** Rang centré (−0,5 … +0,5) de chaque valeur dans un vecteur. */
function centeredRanks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(xs.length);
  idx.forEach((e, r) => { out[e.i] = xs.length > 1 ? r / (xs.length - 1) - 0.5 : 0; });
  return out;
}

interface Row { symbol: string; ts: number; x: number[]; y: Partial<Record<Horizon, number>>; price: number }

export interface PanelOptions {
  extrasAt?: ExtrasAt;
  lambda?: number;
  /** une observation toutes les `sampleStep` séances */
  sampleStep?: number;
  /** profondeur d'entraînement (séances) */
  lookback?: number;
  horizons?: Horizon[];
  /** au moins tant de valeurs par date pour calculer les rangs et la moyenne transversale */
  minSymbolsPerDate?: number;
}

/**
 * Entraîne le panel sur les données antérieures ou égales à `upTo` (null = tout) et prédit, pour
 * chaque valeur, le rendement relatif à chaque horizon à la dernière date disponible ≤ `upTo`.
 */
export function panelModel(universe: Map<string, Candle[]>, upTo: number | null, opts: PanelOptions = {}): PanelResult {
  const horizons = opts.horizons ?? (["1W", "1M", "3M"] as Horizon[]);
  const lambda = opts.lambda ?? 20;
  const sampleStep = opts.sampleStep ?? 2;
  const lookback = opts.lookback ?? 1000;
  const minSymbols = opts.minSymbolsPerDate ?? 5;
  const prepared = [...universe.entries()].map(([s, c]) => prepare(s, upTo == null ? c : c.filter((x) => x.ts <= upTo)));
  const all = new Set<number>();
  for (const p of prepared) for (const c of p.candles) all.add(c.ts);
  const timeline = [...all].sort((a, b) => a - b);
  const asOf = timeline[timeline.length - 1] ?? 0;
  const maxH = Math.max(...horizons.map((h) => HORIZON_DAYS[h]));
  const first = Math.max(0, timeline.length - 1 - lookback);
  const dates: number[] = [];
  for (let i = first; i < timeline.length - 1; i += sampleStep) dates.push(timeline[i]);
  if (!dates.includes(asOf)) dates.push(asOf);
  const rows: Row[] = [];
  for (const ts of dates) {
    const atDate: { p: Prepared; t: number; f: number[] }[] = [];
    for (const p of prepared) {
      const t = p.byTs.get(ts);
      if (t == null) continue;
      const f = rawFeatures(p, t);
      if (f) atDate.push({ p, t, f });
    }
    if (atDate.length < minSymbols) continue;
    const rMom21 = centeredRanks(atDate.map((a) => a.f[0]));
    const rMom63 = centeredRanks(atDate.map((a) => a.f[1]));
    const rVol = centeredRanks(atDate.map((a) => a.f[3]));
    // cibles : rendement relatif à la moyenne des valeurs disposant du même horizon
    const fwd: Partial<Record<Horizon, number[]>> = {};
    for (const h of horizons) {
      const hd = HORIZON_DAYS[h];
      fwd[h] = atDate.map((a) => (a.t + hd < a.p.closes.length ? Math.log(a.p.closes[a.t + hd] / a.p.closes[a.t]) : NaN));
    }
    const means: Partial<Record<Horizon, number>> = {};
    for (const h of horizons) {
      const v = fwd[h]!.filter(Number.isFinite);
      means[h] = v.length >= minSymbols ? mean(v) : NaN;
    }
    atDate.forEach((a, k) => {
      const price = a.p.closes[a.t];
      const ex = opts.extrasAt?.(a.p.symbol, ts, price) ?? { dividendYieldPct: null, earningsYieldPct: null, daysToExDividend: null };
      const x = [...a.f, rMom21[k], rMom63[k], rVol[k], ex.dividendYieldPct ?? 0, ex.earningsYieldPct ?? 0, ex.daysToExDividend != null && ex.daysToExDividend > 0 && ex.daysToExDividend <= 30 ? 1 : 0];
      const y: Partial<Record<Horizon, number>> = {};
      for (const h of horizons) {
        const v = fwd[h]![k];
        if (Number.isFinite(v) && Number.isFinite(means[h]!)) y[h] = v - means[h]!;
      }
      rows.push({ symbol: a.p.symbol, ts, x, y, price });
    });
  }
  const predictions = new Map<string, Partial<Record<Horizon, PanelPrediction>>>();
  const stats: PanelHorizonStats[] = [];
  const lastRows = rows.filter((r) => r.ts === asOf);
  for (const h of horizons) {
    const train = rows.filter((r) => r.y[h] != null);
    const stat: PanelHorizonStats = { horizon: h, samples: train.length, testSamples: 0, testMaePct: null, naiveMaePct: null, hitRate: null, lambda };
    if (train.length >= 200) {
      // test chronologique sur les 30 % de dates les plus récentes
      const cut = train[Math.floor(train.length * 0.7)].ts;
      const fit = train.filter((r) => r.ts < cut);
      const test = train.filter((r) => r.ts >= cut);
      if (fit.length >= 100 && test.length >= 30) {
        const m = fitRidge(fit, h, lambda);
        let err = 0;
        let naive = 0;
        let hits = 0;
        for (const r of test) {
          const pred = m.predict(r.x);
          err += Math.abs(pred - r.y[h]!);
          naive += Math.abs(r.y[h]!);
          if (Math.sign(pred) === Math.sign(r.y[h]!) && pred !== 0) hits++;
        }
        stat.testSamples = test.length;
        stat.testMaePct = Math.round((err / test.length) * 1000) / 10;
        stat.naiveMaePct = Math.round((naive / test.length) * 1000) / 10;
        stat.hitRate = Math.round((hits / test.length) * 100) / 100;
      }
      const full = fitRidge(train, h, lambda);
      for (const r of lastRows) {
        const { pred, contributions } = full.explain(r.x);
        const entry = predictions.get(r.symbol) ?? {};
        entry[h] = { relPct: Math.round(pred * 1000) / 10, contributions };
        predictions.set(r.symbol, entry);
      }
    }
    stats.push(stat);
  }
  return { asOf, symbols: lastRows.length, predictions, stats };
}

function fitRidge(rows: Row[], h: Horizon, lambda: number) {
  const k = rows[0].x.length;
  const mu = Array.from({ length: k }, (_, j) => mean(rows.map((r) => r.x[j])));
  const sd = Array.from({ length: k }, (_, j) => stddev(rows.map((r) => r.x[j])) || 1);
  const z = (x: number[]) => x.map((v, j) => (v - mu[j]) / sd[j]);
  const beta = ridge(rows.map((r) => z(r.x)), rows.map((r) => r.y[h]!), lambda);
  const predict = (x: number[]) => {
    const zx = z(x);
    let p = beta[0];
    for (let j = 0; j < zx.length; j++) p += beta[j + 1] * zx[j];
    return p;
  };
  const explain = (x: number[]) => {
    const zx = z(x);
    let pred = beta[0];
    const contributions: Contribution[] = [];
    for (let j = 0; j < zx.length; j++) {
      const c = beta[j + 1] * zx[j];
      pred += c;
      contributions.push({ factor: PANEL_FACTORS[j].key, label: PANEL_FACTORS[j].label, value: x[j], contributionPct: Math.round(c * 1000) / 10 });
    }
    return { pred, contributions };
  };
  return { predict, explain };
}
