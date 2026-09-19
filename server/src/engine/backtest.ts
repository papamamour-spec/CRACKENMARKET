import { ema, macd, rsi, sma, type Candle } from "./indicators.js";

export type StrategyName = "sma_cross" | "rsi_reversion" | "macd" | "buy_hold";

export interface BacktestResult {
  strategy: StrategyName;
  symbol: string;
  startTs: number;
  endTs: number;
  initialCapital: number;
  finalEquity: number;
  totalReturnPct: number;
  buyHoldReturnPct: number;
  trades: number;
  winRate: number;
  maxDrawdownPct: number;
  equityCurve: { time: number; value: number }[];
  signals: { time: number; side: "buy" | "sell"; price: number }[];
}

const FEE = 0.0125; // frais de courtage BRVM approximatifs (1,25 % par ordre)

export function backtest(symbol: string, candles: Candle[], strategy: StrategyName, initialCapital = 1_000_000): BacktestResult {
  const closes = candles.map((c) => c.close);
  const n = closes.length;
  const sig = signals(strategy, candles);
  let cash = initialCapital;
  let qty = 0;
  let entry = 0;
  let wins = 0;
  let trades = 0;
  let peak = initialCapital;
  let mdd = 0;
  const equityCurve: BacktestResult["equityCurve"] = [];
  const out: BacktestResult["signals"] = [];
  for (let i = 0; i < n; i++) {
    const p = closes[i];
    if (sig[i] === 1 && qty === 0) {
      qty = Math.floor((cash * (1 - FEE)) / p);
      if (qty > 0) {
        cash -= qty * p * (1 + FEE);
        entry = p;
        out.push({ time: candles[i].ts, side: "buy", price: p });
      }
    } else if (sig[i] === -1 && qty > 0) {
      cash += qty * p * (1 - FEE);
      trades++;
      if (p > entry * (1 + 2 * FEE)) wins++;
      qty = 0;
      out.push({ time: candles[i].ts, side: "sell", price: p });
    }
    const eq = cash + qty * p;
    peak = Math.max(peak, eq);
    mdd = Math.min(mdd, eq / peak - 1);
    equityCurve.push({ time: candles[i].ts, value: Math.round(eq) });
  }
  const finalEquity = cash + qty * closes[n - 1];
  if (qty > 0) {
    trades++;
    if (closes[n - 1] > entry) wins++;
  }
  return {
    strategy,
    symbol,
    startTs: candles[0]?.ts ?? 0,
    endTs: candles[n - 1]?.ts ?? 0,
    initialCapital,
    finalEquity: Math.round(finalEquity),
    totalReturnPct: Math.round((finalEquity / initialCapital - 1) * 1000) / 10,
    buyHoldReturnPct: Math.round((closes[n - 1] / closes[0] - 1) * 1000) / 10,
    trades,
    winRate: trades ? Math.round((wins / trades) * 100) : 0,
    maxDrawdownPct: Math.round(mdd * 1000) / 10,
    equityCurve,
    signals: out,
  };
}

function signals(strategy: StrategyName, candles: Candle[]): number[] {
  const closes = candles.map((c) => c.close);
  const n = closes.length;
  const out = new Array<number>(n).fill(0);
  if (strategy === "buy_hold") {
    if (n) out[0] = 1;
    return out;
  }
  if (strategy === "sma_cross") {
    const fast = sma(closes, 20);
    const slow = sma(closes, 50);
    for (let i = 1; i < n; i++) {
      if (isNaN(fast[i]) || isNaN(slow[i]) || isNaN(fast[i - 1]) || isNaN(slow[i - 1])) continue;
      if (fast[i] > slow[i] && fast[i - 1] <= slow[i - 1]) out[i] = 1;
      if (fast[i] < slow[i] && fast[i - 1] >= slow[i - 1]) out[i] = -1;
    }
  } else if (strategy === "rsi_reversion") {
    const r = rsi(closes, 14);
    const trendFilter = ema(closes, 100);
    for (let i = 1; i < n; i++) {
      if (isNaN(r[i])) continue;
      if (r[i] < 30 && (isNaN(trendFilter[i]) || closes[i] > trendFilter[i] * 0.9)) out[i] = 1;
      if (r[i] > 65) out[i] = -1;
    }
  } else if (strategy === "macd") {
    const m = macd(closes);
    for (let i = 1; i < n; i++) {
      if (isNaN(m.histogram[i]) || isNaN(m.histogram[i - 1])) continue;
      if (m.histogram[i] > 0 && m.histogram[i - 1] <= 0) out[i] = 1;
      if (m.histogram[i] < 0 && m.histogram[i - 1] >= 0) out[i] = -1;
    }
  }
  return out;
}
