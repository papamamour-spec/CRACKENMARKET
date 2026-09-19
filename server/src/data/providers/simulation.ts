import { INSTRUMENTS, type InstrumentDef } from "../instruments.js";
import type { Candle } from "../../engine/indicators.js";
import type { MarketDataProvider, Quote } from "./types.js";

/**
 * Générateur pseudo-aléatoire déterministe (mulberry32) pour un historique reproductible.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function hashSymbol(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Pas de cotation BRVM : 5 FCFA sous 1 000, sinon arrondi à l'unité (ETIT en 1 FCFA). */
export function roundTick(price: number, symbol: string): number {
  if (symbol === "ETIT") return Math.max(1, Math.round(price));
  if (price < 1000) return Math.max(5, Math.round(price / 5) * 5);
  return Math.round(price);
}

export function isTradingDay(d: Date): boolean {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

/**
 * Historique quotidien synthétique : mouvement brownien géométrique avec régimes
 * (tendances persistantes) et saisonnalité de volume, ancré sur `endPrice` (par défaut
 * le prix de référence actuel) à la date `endDate`. `seedSalt` permet d'obtenir une
 * trajectoire différente pour un même symbole (utile pour prolonger un historique existant).
 */
export function generateDailyHistory(
  inst: InstrumentDef,
  days: number,
  endDate = new Date(),
  endPrice = inst.refPrice,
  seedSalt = 0,
): Candle[] {
  if (days <= 0) return [];
  const rand = mulberry32((hashSymbol(inst.symbol) ^ 0x9e3779b9) + seedSalt * 0x85ebca6b);
  const dailyVol = inst.volatility / Math.sqrt(252);
  const n = days;
  // On génère à rebours depuis le prix d'ancrage pour que le dernier close = endPrice
  const closes: number[] = new Array(n);
  closes[n - 1] = endPrice;
  let regime = 0;
  for (let i = n - 2; i >= 0; i--) {
    if (rand() < 0.03) regime = (rand() - 0.5) * 0.004; // nouveau régime de tendance
    const shock = gaussian(rand) * dailyVol;
    // marche arrière : close[i] = close[i+1] / exp(drift + shock)
    closes[i] = closes[i + 1] / Math.exp(regime + shock);
  }
  const candles: Candle[] = [];
  const cursor = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
  // Reculer jusqu'à couvrir n jours de bourse
  const dates: number[] = [];
  const c2 = new Date(cursor);
  while (dates.length < n) {
    if (isTradingDay(c2)) dates.push(c2.getTime());
    c2.setUTCDate(c2.getUTCDate() - 1);
  }
  dates.reverse();
  for (let i = 0; i < n; i++) {
    const close = roundTick(closes[i], inst.symbol);
    const prevClose = i === 0 ? close : candles[i - 1].close;
    const open = roundTick(prevClose * (1 + gaussian(rand) * dailyVol * 0.3), inst.symbol);
    const range = Math.abs(gaussian(rand)) * dailyVol * close;
    const high = roundTick(Math.max(open, close) + range * rand(), inst.symbol);
    const low = roundTick(Math.min(open, close) - range * rand(), inst.symbol);
    const volSeason = 0.6 + rand() * 0.9 + (Math.abs(close / prevClose - 1) > dailyVol ? 1.2 : 0);
    const volume = Math.max(0, Math.round(inst.avgVolume * volSeason));
    candles.push({ ts: dates[i], open, high: Math.max(high, open, close), low: Math.min(low, open, close), close, volume });
  }
  return candles;
}

interface SimState {
  price: number;
  sessionVolume: number;
  drift: number;
}

export class SimulationProvider implements MarketDataProvider {
  readonly name = "simulation" as const;
  private timer: NodeJS.Timeout | null = null;
  private state = new Map<string, SimState>();
  private rand = mulberry32(Date.now() & 0xffffffff);

  constructor(private readonly tickIntervalMs: number, initialPrices?: Map<string, number>) {
    for (const inst of INSTRUMENTS) {
      this.state.set(inst.symbol, {
        price: initialPrices?.get(inst.symbol) ?? inst.refPrice,
        sessionVolume: 0,
        drift: 0,
      });
    }
  }

  async healthcheck(): Promise<boolean> {
    return true;
  }

  async fetchDailyHistory(symbol: string, days: number): Promise<Candle[]> {
    const inst = INSTRUMENTS.find((i) => i.symbol === symbol);
    if (!inst) return [];
    return generateDailyHistory(inst, days);
  }

  async start(onQuotes: (quotes: Quote[]) => void): Promise<void> {
    this.stop();
    this.timer = setInterval(() => onQuotes(this.step()), this.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Une itération : quelques valeurs bougent (marché peu liquide), les autres restent. */
  private step(): Quote[] {
    const now = Date.now();
    const quotes: Quote[] = [];
    const secondsPerDay = 5 * 3600;
    for (const inst of INSTRUMENTS) {
      const s = this.state.get(inst.symbol)!;
      // probabilité d'échange proportionnelle à la liquidité
      const pTrade = Math.min(0.9, 0.15 + inst.avgVolume / 20000);
      if (this.rand() > pTrade) continue;
      if (this.rand() < 0.02) s.drift = (this.rand() - 0.5) * 0.002;
      const dt = this.tickIntervalMs / 1000 / secondsPerDay;
      const dailyVol = inst.volatility / Math.sqrt(252);
      const shock = gaussian(this.rand) * dailyVol * Math.sqrt(dt) * 6; // ticks plus nerveux
      let next = s.price * Math.exp(s.drift * dt * 50 + shock);
      // limites journalières BRVM ±7,5 % (approximation autour du prix courant)
      next = Math.min(inst.refPrice * 1.3, Math.max(inst.refPrice * 0.7, next));
      const price = roundTick(next, inst.symbol);
      const qty = Math.max(1, Math.round((inst.avgVolume / 40) * (0.2 + this.rand() * 1.6)));
      s.price = price;
      s.sessionVolume += qty;
      quotes.push({ symbol: inst.symbol, price, volume: s.sessionVolume, ts: now, source: "simulation" });
    }
    return quotes;
  }

  resetSession(): void {
    for (const s of this.state.values()) s.sessionVolume = 0;
  }
}
