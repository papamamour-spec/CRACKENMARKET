/**
 * Bibliothèque d'indicateurs techniques – pure, sans dépendance.
 * Toutes les fonctions retournent des tableaux alignés sur l'entrée (NaN quand non défini).
 */

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const fastE = ema(closes, fast);
  const slowE = ema(closes, slow);
  const line = closes.map((_, i) => (isNaN(fastE[i]) || isNaN(slowE[i]) ? NaN : fastE[i] - slowE[i]));
  // signal = EMA de la ligne MACD sur les valeurs définies
  const firstIdx = line.findIndex((v) => !isNaN(v));
  const signal = new Array<number>(closes.length).fill(NaN);
  if (firstIdx >= 0) {
    const sub = ema(line.slice(firstIdx), signalPeriod);
    for (let i = 0; i < sub.length; i++) signal[firstIdx + i] = sub[i];
  }
  const histogram = line.map((v, i) => (isNaN(v) || isNaN(signal[i]) ? NaN : v - signal[i]));
  return { macd: line, signal, histogram };
}

export interface BollingerResult {
  middle: number[];
  upper: number[];
  lower: number[];
  bandwidth: number[];
  percentB: number[];
}

export function bollinger(closes: number[], period = 20, mult = 2): BollingerResult {
  const middle = sma(closes, period);
  const upper = new Array<number>(closes.length).fill(NaN);
  const lower = new Array<number>(closes.length).fill(NaN);
  const bandwidth = new Array<number>(closes.length).fill(NaN);
  const percentB = new Array<number>(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - middle[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = middle[i] + mult * sd;
    lower[i] = middle[i] - mult * sd;
    bandwidth[i] = middle[i] === 0 ? NaN : (upper[i] - lower[i]) / middle[i];
    percentB[i] = upper[i] === lower[i] ? 0.5 : (closes[i] - lower[i]) / (upper[i] - lower[i]);
  }
  return { middle, upper, lower, bandwidth, percentB };
}

export function atr(candles: Candle[], period = 14): number[] {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  // Wilder smoothing
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length < period) return out;
  let acc = 0;
  for (let i = 0; i < period; i++) acc += tr[i];
  let prev = acc / period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function obv(candles: Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    out[i] = out[i - 1] + (d > 0 ? candles[i].volume : d < 0 ? -candles[i].volume : 0);
  }
  return out;
}

export function stochastic(candles: Candle[], kPeriod = 14, dPeriod = 3): { k: number[]; d: number[] } {
  const k = new Array<number>(candles.length).fill(NaN);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hi = Math.max(hi, candles[j].high);
      lo = Math.min(lo, candles[j].low);
    }
    k[i] = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
  }
  const firstIdx = k.findIndex((v) => !isNaN(v));
  const d = new Array<number>(candles.length).fill(NaN);
  if (firstIdx >= 0) {
    const sub = sma(k.slice(firstIdx), dPeriod);
    for (let i = 0; i < sub.length; i++) d[firstIdx + i] = sub[i];
  }
  return { k, d };
}

/** Rendements logarithmiques quotidiens */
export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Volatilité annualisée (base 252 séances) */
export function annualizedVolatility(closes: number[], window = 60): number {
  const r = logReturns(closes.slice(-(window + 1)));
  return stddev(r) * Math.sqrt(252);
}

export function maxDrawdown(closes: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    mdd = Math.min(mdd, c / peak - 1);
  }
  return mdd; // valeur négative (ex: -0.23)
}

export function sharpe(closes: number[], riskFreeAnnual = 0.05): number {
  const r = logReturns(closes);
  if (r.length < 2) return 0;
  const sd = stddev(r);
  if (sd === 0) return 0;
  const excess = mean(r) - riskFreeAnnual / 252;
  return (excess / sd) * Math.sqrt(252);
}

/** Pente de régression linéaire normalisée (en % par période) */
export function slopePct(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xs = Array.from({ length: n }, (_, i) => i);
  const mx = mean(xs);
  const my = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (values[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return my === 0 ? 0 : (slope / my) * 100;
}

export function pctChange(closes: number[], lookback: number): number {
  if (closes.length <= lookback) return 0;
  const a = closes[closes.length - 1 - lookback];
  const b = closes[closes.length - 1];
  return a === 0 ? 0 : (b / a - 1) * 100;
}

export function last<T>(xs: T[]): T {
  return xs[xs.length - 1];
}
