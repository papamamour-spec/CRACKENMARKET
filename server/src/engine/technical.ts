import {
  annualizedVolatility,
  atr,
  bollinger,
  ema,
  macd,
  maxDrawdown,
  obv,
  pctChange,
  rsi,
  sharpe,
  slopePct,
  sma,
  stochastic,
  type Candle,
} from "./indicators.js";

export interface TechnicalSnapshot {
  symbol: string;
  price: number;
  sma20: number;
  sma50: number;
  sma200: number;
  ema12: number;
  ema26: number;
  rsi14: number;
  macd: number;
  macdSignal: number;
  macdHist: number;
  bollUpper: number;
  bollLower: number;
  bollPercentB: number;
  bollBandwidth: number;
  atr14: number;
  stochK: number;
  stochD: number;
  obvSlope: number;
  volatility60: number;
  maxDrawdown250: number;
  sharpe250: number;
  perf1w: number;
  perf1m: number;
  perf3m: number;
  perf6m: number;
  perf1y: number;
  volumeRatio: number; // volume 5j / volume 60j
  support: number;
  resistance: number;
  /** Scores normalisés [-1, 1] */
  scores: {
    trend: number;
    momentum: number;
    meanReversion: number;
    volume: number;
    risk: number; // -1 = très risqué, +1 = très calme
    composite: number; // score global [-1, 1]
  };
  signals: string[];
}

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const nz = (v: number, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/** Calcule l'ensemble des indicateurs et un score composite pour une série de bougies quotidiennes. */
export function analyze(symbol: string, candles: Candle[]): TechnicalSnapshot {
  const closes = candles.map((c) => c.close);
  const n = closes.length;
  const lastC = closes[n - 1] ?? 0;
  const s20 = nz(sma(closes, 20)[n - 1], lastC);
  const s50 = nz(sma(closes, 50)[n - 1], lastC);
  const s200 = nz(sma(closes, 200)[n - 1], lastC);
  const e12 = nz(ema(closes, 12)[n - 1], lastC);
  const e26 = nz(ema(closes, 26)[n - 1], lastC);
  const r = nz(rsi(closes, 14)[n - 1], 50);
  const m = macd(closes);
  const b = bollinger(closes);
  const a = nz(atr(candles, 14)[n - 1], lastC * 0.01);
  const st = stochastic(candles);
  const o = obv(candles);
  const obvSlope = o.length > 20 ? slopePct(o.slice(-20).map((v) => v - o[o.length - 21] + 1)) : 0;
  const vol60 = annualizedVolatility(closes, 60);
  const mdd = maxDrawdown(closes.slice(-250));
  const sh = sharpe(closes.slice(-250));
  const vols = candles.map((c) => c.volume);
  const v5 = avg(vols.slice(-5));
  const v60 = avg(vols.slice(-60)) || 1;
  const win = candles.slice(-60);
  const support = win.length ? Math.min(...win.map((c) => c.low)) : lastC;
  const resistance = win.length ? Math.max(...win.map((c) => c.high)) : lastC;

  // --- Scores ---
  const signals: string[] = [];
  // Tendance : position vs moyennes mobiles + pente 50j
  let trend = 0;
  if (lastC > s20) trend += 0.25;
  else trend -= 0.25;
  if (lastC > s50) trend += 0.25;
  else trend -= 0.25;
  if (lastC > s200) trend += 0.25;
  else trend -= 0.25;
  if (s50 > s200) trend += 0.25;
  else trend -= 0.25;
  const slope50 = slopePct(closes.slice(-50));
  trend = clamp(trend * 0.7 + clamp(slope50 * 4) * 0.3);
  if (s50 > s200 && closes[n - 2] !== undefined && sma(closes, 50)[n - 2] <= sma(closes, 200)[n - 2]) {
    signals.push("Croisement doré (MM50 > MM200) : signal haussier de long terme");
  }
  if (s50 < s200 && closes[n - 2] !== undefined && sma(closes, 50)[n - 2] >= sma(closes, 200)[n - 2]) {
    signals.push("Croisement de la mort (MM50 < MM200) : signal baissier de long terme");
  }

  // Momentum : RSI, MACD, performances récentes
  let momentum = 0;
  momentum += clamp((r - 50) / 25) * 0.35;
  const hist = nz(m.histogram[n - 1]);
  momentum += clamp(hist / (a || 1)) * 0.3;
  momentum += clamp(pctChange(closes, 21) / 10) * 0.35;
  momentum = clamp(momentum);
  if (hist > 0 && nz(m.histogram[n - 2]) <= 0) signals.push("MACD croise au-dessus de sa ligne de signal");
  if (hist < 0 && nz(m.histogram[n - 2]) >= 0) signals.push("MACD croise en dessous de sa ligne de signal");

  // Retour à la moyenne : RSI extrêmes et bandes de Bollinger (opportunité contrarienne)
  let meanReversion = 0;
  const pb = nz(b.percentB[n - 1], 0.5);
  if (r < 30) {
    meanReversion += 0.5;
    signals.push(`RSI en zone de survente (${r.toFixed(0)})`);
  }
  if (r > 70) {
    meanReversion -= 0.5;
    signals.push(`RSI en zone de surachat (${r.toFixed(0)})`);
  }
  if (pb < 0) {
    meanReversion += 0.5;
    signals.push("Cours sous la bande de Bollinger inférieure");
  }
  if (pb > 1) {
    meanReversion -= 0.5;
    signals.push("Cours au-dessus de la bande de Bollinger supérieure");
  }
  meanReversion = clamp(meanReversion);

  // Volume : confirmation par les volumes et l'OBV
  const volumeRatio = v5 / v60;
  let volume = clamp((volumeRatio - 1) * 0.8) * 0.5 + clamp(obvSlope / 5) * 0.5;
  volume = clamp(volume);
  if (volumeRatio > 1.8) signals.push(`Volumes en forte hausse (×${volumeRatio.toFixed(1)} vs 60 séances)`);

  // Risque : volatilité et drawdown
  const risk = clamp(1 - vol60 / 0.35 - Math.abs(mdd) * 0.8);
  if (vol60 > 0.4) signals.push(`Volatilité élevée (${(vol60 * 100).toFixed(0)} % annualisée)`);

  const composite = clamp(trend * 0.35 + momentum * 0.3 + meanReversion * 0.15 + volume * 0.1 + risk * 0.1);
  if (lastC <= support * 1.01) signals.push("Cours proche du support 60 séances");
  if (lastC >= resistance * 0.99) signals.push("Cours proche de la résistance 60 séances");

  return {
    symbol,
    price: lastC,
    sma20: s20,
    sma50: s50,
    sma200: s200,
    ema12: e12,
    ema26: e26,
    rsi14: r,
    macd: nz(m.macd[n - 1]),
    macdSignal: nz(m.signal[n - 1]),
    macdHist: hist,
    bollUpper: nz(b.upper[n - 1], lastC),
    bollLower: nz(b.lower[n - 1], lastC),
    bollPercentB: pb,
    bollBandwidth: nz(b.bandwidth[n - 1]),
    atr14: a,
    stochK: nz(st.k[n - 1], 50),
    stochD: nz(st.d[n - 1], 50),
    obvSlope,
    volatility60: vol60,
    maxDrawdown250: mdd,
    sharpe250: sh,
    perf1w: pctChange(closes, 5),
    perf1m: pctChange(closes, 21),
    perf3m: pctChange(closes, 63),
    perf6m: pctChange(closes, 126),
    perf1y: pctChange(closes, 250),
    volumeRatio,
    support,
    resistance,
    scores: { trend, momentum, meanReversion, volume, risk, composite },
    signals,
  };
}

/** Séries d'indicateurs pour affichage sur le graphique. */
export function indicatorSeries(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  const b = bollinger(closes);
  const m = macd(closes);
  const r = rsi(closes);
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const pack = (arr: number[]) => candles.map((c, i) => ({ time: c.ts, value: arr[i] })).filter((p) => Number.isFinite(p.value));
  return {
    sma20: pack(s20),
    sma50: pack(s50),
    sma200: pack(s200),
    bollUpper: pack(b.upper),
    bollLower: pack(b.lower),
    rsi: pack(r),
    macd: pack(m.macd),
    macdSignal: pack(m.signal),
    macdHist: pack(m.histogram),
  };
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
