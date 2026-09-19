import type { Candle } from "../../engine/indicators.js";

export interface Quote {
  symbol: string;
  price: number;
  volume: number; // volume cumulé de la séance
  ts: number;
  source: "live" | "simulation";
}

export interface MarketDataProvider {
  readonly name: "live" | "simulation";
  /** Démarre la diffusion; le callback est appelé pour chaque mise à jour de cours. */
  start(onQuotes: (quotes: Quote[]) => void): Promise<void>;
  stop(): void;
  /** Historique quotidien (le plus ancien en premier). Peut renvoyer [] si non supporté. */
  fetchDailyHistory(symbol: string, days: number): Promise<Candle[]>;
  /** Vérifie que la source est joignable. */
  healthcheck(): Promise<boolean>;
}
