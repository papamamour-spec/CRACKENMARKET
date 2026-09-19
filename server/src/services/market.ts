import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { config } from "../config.js";
import { INSTRUMENTS, INSTRUMENT_MAP, type InstrumentDef } from "../data/instruments.js";
import { LiveBrvmProvider } from "../data/providers/live.js";
import { SimulationProvider, generateDailyHistory, isTradingDay } from "../data/providers/simulation.js";
import type { MarketDataProvider, Quote } from "../data/providers/types.js";
import type { Candle } from "../engine/indicators.js";

export interface QuoteSnapshot {
  symbol: string;
  name: string;
  sector: string;
  country: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  change: number; // FCFA
  changePct: number;
  volume: number;
  value: number; // capitaux échangés (FCFA)
  ts: number;
  source: "live" | "simulation";
  brvm30: boolean;
}

export interface IndexSnapshot {
  name: string;
  value: number;
  changePct: number;
  ts: number;
}

export interface MarketEvents {
  quotes: (quotes: QuoteSnapshot[]) => void;
  indices: (indices: IndexSnapshot[]) => void;
  status: (status: MarketStatus) => void;
}

export interface MarketStatus {
  provider: "live" | "simulation";
  open: boolean;
  serverTime: number;
  nextOpen: number;
  nextClose: number;
}

const INDEX_BASE_KEY = "index_base";

export class MarketService extends EventEmitter {
  private provider!: MarketDataProvider;
  private candles = new Map<string, Candle[]>(); // historique quotidien par valeur
  private snapshots = new Map<string, QuoteSnapshot>();
  private intraday = new Map<string, Candle[]>(); // bougies 1 minute de la séance
  private indexBase = new Map<string, number>();
  private lastValue = new Map<string, number>(); // capitaux cumulés (prix * volume approx.)
  private started = false;

  constructor(private readonly db: DB) {
    super();
  }

  get providerName(): "live" | "simulation" {
    return this.provider?.name ?? "simulation";
  }

  /** Sélection du fournisseur et chargement de l'historique. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.loadOrSeedHistory();
    for (const inst of INSTRUMENTS) this.initSnapshot(inst);
    this.provider = await this.pickProvider();
    console.log(`[market] fournisseur de données : ${this.provider.name}`);
    this.loadIndexBase();
    await this.provider.start((qs) => this.ingest(qs));
    this.emitIndices();
    setInterval(() => this.emit("status", this.status()), 30_000);
  }

  private async pickProvider(): Promise<MarketDataProvider> {
    const initial = new Map(INSTRUMENTS.map((i) => [i.symbol, this.lastClose(i.symbol)]));
    const sim = new SimulationProvider(config.simTickIntervalMs, initial);
    if (config.providerMode === "simulation") return sim;
    const live = new LiveBrvmProvider(config.livePollIntervalMs);
    const ok = await live.healthcheck();
    if (ok) return live;
    if (config.providerMode === "live") {
      console.warn("[market] DATA_PROVIDER=live mais la source est injoignable ; bascule en simulation.");
    }
    return sim;
  }

  private async loadOrSeedHistory(): Promise<void> {
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM candles").get() as { n: number };
    if (count.n === 0) {
      console.log(`[market] génération de ${config.historyDays} jours d'historique synthétique…`);
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO candles(symbol, ts, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)",
      );
      const tx = this.db.transaction(() => {
        for (const inst of INSTRUMENTS) {
          for (const c of generateDailyHistory(inst, config.historyDays)) {
            insert.run(inst.symbol, c.ts, c.open, c.high, c.low, c.close, c.volume);
          }
        }
      });
      tx();
    }
    const rows = this.db
      .prepare("SELECT symbol, ts, open, high, low, close, volume FROM candles ORDER BY symbol, ts")
      .all() as (Candle & { symbol: string })[];
    for (const r of rows) {
      const arr = this.candles.get(r.symbol) ?? [];
      arr.push({ ts: r.ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
      this.candles.set(r.symbol, arr);
    }
  }

  private lastClose(symbol: string): number {
    const arr = this.candles.get(symbol);
    return arr?.length ? arr[arr.length - 1].close : INSTRUMENT_MAP.get(symbol)!.refPrice;
  }

  private initSnapshot(inst: InstrumentDef): void {
    const hist = this.candles.get(inst.symbol) ?? [];
    const today = startOfDayUtc(Date.now());
    const lastCandle = hist[hist.length - 1];
    const prev = lastCandle && lastCandle.ts < today ? lastCandle.close : (hist[hist.length - 2]?.close ?? inst.refPrice);
    const price = lastCandle?.close ?? inst.refPrice;
    this.snapshots.set(inst.symbol, {
      symbol: inst.symbol,
      name: inst.name,
      sector: inst.sector,
      country: inst.country,
      price,
      prevClose: prev,
      open: price,
      high: price,
      low: price,
      change: price - prev,
      changePct: prev ? ((price - prev) / prev) * 100 : 0,
      volume: 0,
      value: 0,
      ts: lastCandle?.ts ?? Date.now(),
      source: "simulation",
      brvm30: inst.brvm30,
    });
  }

  private loadIndexBase(): void {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(INDEX_BASE_KEY) as { value: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as Record<string, number>;
      for (const [k, v] of Object.entries(parsed)) this.indexBase.set(k, v);
      return;
    }
    // Base : la somme pondérée des cours de clôture précédents = 100 points… puis mise à l'échelle
    // pour ressembler aux niveaux réels (BRVM Composite ≈ 250, BRVM 30 ≈ 125).
    const composite = this.rawIndex(false, true);
    const b30 = this.rawIndex(true, true);
    this.indexBase.set("BRVM Composite", composite / 250);
    this.indexBase.set("BRVM 30", b30 / 125);
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run(INDEX_BASE_KEY, JSON.stringify(Object.fromEntries(this.indexBase)));
  }

  /** Indice pondéré par un proxy de capitalisation (prix × volume moyen × facteur sectoriel). */
  private rawIndex(only30: boolean, usePrevClose: boolean): number {
    let total = 0;
    for (const inst of INSTRUMENTS) {
      if (only30 && !inst.brvm30) continue;
      const s = this.snapshots.get(inst.symbol)!;
      const weight = inst.avgVolume * 50; // proxy du flottant
      total += (usePrevClose ? s.prevClose : s.price) * weight;
    }
    return total;
  }

  private ingest(quotes: Quote[]): void {
    const updated: QuoteSnapshot[] = [];
    const insertTick = this.db.prepare("INSERT INTO ticks(symbol, ts, price, volume, source) VALUES (?,?,?,?,?)");
    const tx = this.db.transaction(() => {
      for (const q of quotes) {
        const s = this.snapshots.get(q.symbol);
        if (!s) continue;
        const tradedQty = Math.max(0, q.volume - s.volume);
        s.price = q.price;
        s.high = Math.max(s.high, q.price);
        s.low = Math.min(s.low, q.price);
        s.volume = q.volume;
        s.value += tradedQty * q.price;
        s.change = q.price - s.prevClose;
        s.changePct = s.prevClose ? (s.change / s.prevClose) * 100 : 0;
        s.ts = q.ts;
        s.source = q.source;
        this.updateIntraday(q, tradedQty);
        this.updateDailyCandle(q, tradedQty);
        insertTick.run(q.symbol, q.ts, q.price, tradedQty, q.source);
        updated.push({ ...s });
      }
    });
    tx();
    if (updated.length) {
      this.emit("quotes", updated);
      this.emitIndices();
    }
  }

  private updateIntraday(q: Quote, qty: number): void {
    const minute = Math.floor(q.ts / 60_000) * 60_000;
    const arr = this.intraday.get(q.symbol) ?? [];
    const lastC = arr[arr.length - 1];
    if (lastC && lastC.ts === minute) {
      lastC.high = Math.max(lastC.high, q.price);
      lastC.low = Math.min(lastC.low, q.price);
      lastC.close = q.price;
      lastC.volume += qty;
    } else {
      arr.push({ ts: minute, open: q.price, high: q.price, low: q.price, close: q.price, volume: qty });
      if (arr.length > 600) arr.shift();
    }
    this.intraday.set(q.symbol, arr);
  }

  /** Met à jour (ou crée) la bougie quotidienne du jour, persistée en base. */
  private updateDailyCandle(q: Quote, qty: number): void {
    const day = startOfDayUtc(q.ts);
    const arr = this.candles.get(q.symbol) ?? [];
    const lastC = arr[arr.length - 1];
    if (lastC && lastC.ts === day) {
      lastC.high = Math.max(lastC.high, q.price);
      lastC.low = Math.min(lastC.low, q.price);
      lastC.close = q.price;
      lastC.volume += qty;
    } else {
      arr.push({ ts: day, open: q.price, high: q.price, low: q.price, close: q.price, volume: qty });
      const s = this.snapshots.get(q.symbol)!;
      if (lastC) s.prevClose = lastC.close;
      s.open = q.price;
      s.high = q.price;
      s.low = q.price;
    }
    this.candles.set(q.symbol, arr);
    const c = arr[arr.length - 1];
    this.db
      .prepare("INSERT OR REPLACE INTO candles(symbol, ts, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)")
      .run(q.symbol, c.ts, c.open, c.high, c.low, c.close, c.volume);
  }

  private emitIndices(): void {
    this.emit("indices", this.indices());
  }

  // ---------- API de lecture ----------

  indices(): IndexSnapshot[] {
    const ts = Date.now();
    const compBase = this.indexBase.get("BRVM Composite") ?? 1;
    const b30Base = this.indexBase.get("BRVM 30") ?? 1;
    const comp = this.rawIndex(false, false) / compBase;
    const compPrev = this.rawIndex(false, true) / compBase;
    const b30 = this.rawIndex(true, false) / b30Base;
    const b30Prev = this.rawIndex(true, true) / b30Base;
    return [
      { name: "BRVM Composite", value: round2(comp), changePct: round2(((comp - compPrev) / compPrev) * 100), ts },
      { name: "BRVM 30", value: round2(b30), changePct: round2(((b30 - b30Prev) / b30Prev) * 100), ts },
    ];
  }

  allSnapshots(): QuoteSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  snapshot(symbol: string): QuoteSnapshot | undefined {
    return this.snapshots.get(symbol);
  }

  price(symbol: string): number {
    return this.snapshots.get(symbol)?.price ?? 0;
  }

  history(symbol: string, limit = 500): Candle[] {
    const arr = this.candles.get(symbol) ?? [];
    return arr.slice(-limit);
  }

  /** Agrégation hebdomadaire / mensuelle à partir du quotidien. */
  historyAggregated(symbol: string, timeframe: "1D" | "1W" | "1M" | "1m", limit = 500): Candle[] {
    if (timeframe === "1m") return (this.intraday.get(symbol) ?? []).slice(-limit);
    const daily = this.candles.get(symbol) ?? [];
    if (timeframe === "1D") return daily.slice(-limit);
    const keyOf = (ts: number) => {
      const d = new Date(ts);
      if (timeframe === "1M") return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      // semaine ISO approximative : lundi comme début
      const day = (d.getUTCDay() + 6) % 7;
      const monday = new Date(ts - day * 86_400_000);
      return `${monday.getUTCFullYear()}-${monday.getUTCMonth()}-${monday.getUTCDate()}`;
    };
    const out: Candle[] = [];
    let key = "";
    for (const c of daily) {
      const k = keyOf(c.ts);
      if (k !== key) {
        out.push({ ...c });
        key = k;
      } else {
        const cur = out[out.length - 1];
        cur.high = Math.max(cur.high, c.high);
        cur.low = Math.min(cur.low, c.low);
        cur.close = c.close;
        cur.volume += c.volume;
      }
    }
    return out.slice(-limit);
  }

  recentTicks(symbol: string, limit = 50): { ts: number; price: number; volume: number }[] {
    return this.db
      .prepare("SELECT ts, price, volume FROM ticks WHERE symbol = ? ORDER BY ts DESC LIMIT ?")
      .all(symbol, limit) as { ts: number; price: number; volume: number }[];
  }

  status(): MarketStatus {
    const now = new Date();
    const open = isTradingDay(now) && isWithinSession(now);
    return {
      provider: this.providerName,
      open,
      serverTime: now.getTime(),
      nextOpen: nextSessionBoundary(now, "open"),
      nextClose: nextSessionBoundary(now, "close"),
    };
  }

  sectorSummary(): { sector: string; count: number; avgChangePct: number; value: number }[] {
    const acc = new Map<string, { count: number; sum: number; value: number }>();
    for (const s of this.snapshots.values()) {
      const a = acc.get(s.sector) ?? { count: 0, sum: 0, value: 0 };
      a.count++;
      a.sum += s.changePct;
      a.value += s.value;
      acc.set(s.sector, a);
    }
    return Array.from(acc.entries())
      .map(([sector, a]) => ({ sector, count: a.count, avgChangePct: round2(a.sum / a.count), value: Math.round(a.value) }))
      .sort((x, y) => y.avgChangePct - x.avgChangePct);
  }
}

export function startOfDayUtc(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isWithinSession(d: Date): boolean {
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const o = config.marketOpen.hour * 60 + config.marketOpen.minute;
  const c = config.marketClose.hour * 60 + config.marketClose.minute;
  return mins >= o && mins < c;
}

function nextSessionBoundary(from: Date, kind: "open" | "close"): number {
  const t = kind === "open" ? config.marketOpen : config.marketClose;
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), t.hour, t.minute));
  while (d.getTime() <= from.getTime() || !isTradingDay(d)) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
