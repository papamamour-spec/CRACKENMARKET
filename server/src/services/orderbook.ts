import type { InstrumentDef } from "../data/instruments.js";
import { roundTick } from "../data/providers/simulation.js";

export interface BookLevel {
  price: number;
  quantity: number;
  orders: number;
}

export interface OrderBook {
  symbol: string;
  bids: BookLevel[]; // meilleur prix en premier
  asks: BookLevel[];
  spread: number;
  spreadPct: number;
  imbalance: number; // -1 (pression vendeuse) .. 1 (pression acheteuse)
  ts: number;
  estimated: boolean; // true si reconstitué (pas de flux de profondeur officiel)
}

function tickSize(price: number, symbol: string): number {
  if (symbol === "ETIT") return 1;
  return price < 1000 ? 5 : price < 10000 ? 5 : 10;
}

/**
 * Carnet d'ordres reconstitué autour du dernier cours : la BRVM ne diffuse pas sa profondeur
 * en accès public, on produit donc une estimation cohérente avec la liquidité de chaque valeur
 * (marché en continu, fixing à 5 niveaux de part et d'autre).
 */
export function buildOrderBook(inst: InstrumentDef, price: number, rand: () => number, levels = 5, ts = Date.now()): OrderBook {
  const tick = tickSize(price, inst.symbol);
  // valeurs peu liquides : écart plus large
  const liquidity = Math.min(1, inst.avgVolume / 10000);
  const halfSpreadTicks = liquidity > 0.6 ? 1 : liquidity > 0.2 ? 2 : 3;
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  const baseQty = Math.max(5, Math.round(inst.avgVolume / 25));
  const skew = (rand() - 0.5) * 0.6; // déséquilibre du moment
  for (let i = 0; i < levels; i++) {
    const decay = 1 - i * 0.12;
    const bidPrice = roundTick(price - (halfSpreadTicks + i) * tick, inst.symbol);
    const askPrice = roundTick(price + (halfSpreadTicks + i) * tick, inst.symbol);
    const bq = Math.max(1, Math.round(baseQty * decay * (0.6 + rand()) * (1 + skew)));
    const aq = Math.max(1, Math.round(baseQty * decay * (0.6 + rand()) * (1 - skew)));
    bids.push({ price: bidPrice, quantity: bq, orders: 1 + Math.floor(rand() * 4) });
    asks.push({ price: askPrice, quantity: aq, orders: 1 + Math.floor(rand() * 4) });
  }
  const spread = asks[0].price - bids[0].price;
  const bidVol = bids.reduce((a, l) => a + l.quantity, 0);
  const askVol = asks.reduce((a, l) => a + l.quantity, 0);
  return {
    symbol: inst.symbol,
    bids,
    asks,
    spread,
    spreadPct: price ? Math.round((spread / price) * 10000) / 100 : 0,
    imbalance: bidVol + askVol ? Math.round(((bidVol - askVol) / (bidVol + askVol)) * 100) / 100 : 0,
    ts,
    estimated: true,
  };
}
