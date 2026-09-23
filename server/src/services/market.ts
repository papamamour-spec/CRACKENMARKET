import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { config } from "../config.js";
import { INSTRUMENTS, INSTRUMENT_MAP, type InstrumentDef } from "../data/instruments.js";
import { LiveBrvmProvider } from "../data/providers/live.js";
import { SimulationProvider, generateDailyHistory, isTradingDay } from "../data/providers/simulation.js";
import type { MarketDataProvider, Quote } from "../data/providers/types.js";
import type { Candle } from "../engine/indicators.js";
import { buildOrderBook, type OrderBook } from "./orderbook.js";

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
  /** Variations (%) par période, calculées sur les clôtures ; null si historique insuffisant */
  perf: PeriodPerf;
  high52: number;
  low52: number;
}

export type Period = "1D" | "1W" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "3Y" | "5Y";
export type PeriodPerf = Record<Period, number | null>;
export const PERIODS: Period[] = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y"];
const PERIOD_SESSIONS: Record<Exclude<Period, "1D" | "YTD">, number> = { "1W": 5, "1M": 21, "3M": 63, "6M": 126, "1Y": 250, "3Y": 750, "5Y": 1250 };

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

/**
 * Garantit que chaque valeur dispose d'au moins `days` séances d'historique quotidien.
 * - base vide : historique synthétique généré jusqu'à aujourd'hui, ancré au prix de référence ;
 * - base plus courte (ex. 2 ans avant le passage à 5 ans) : les séances manquantes sont
 *   générées à rebours avant la plus ancienne bougie, ancrées sur son cours d'ouverture,
 *   pour prolonger la série sans rupture.
 * Retourne le nombre de bougies insérées.
 */
export function ensureHistoryDepth(db: DB, days: number): number {
  const stats = db.prepare("SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM candles WHERE symbol = ?");
  const oldestOpen = db.prepare("SELECT open FROM candles WHERE symbol = ? AND ts = ?");
  const insert = db.prepare(
    "INSERT OR REPLACE INTO candles(symbol, ts, open, high, low, close, volume) VALUES (?,?,?,?,?,?,?)",
  );
  const tx = db.transaction((): number => {
    let generated = 0;
    for (const inst of INSTRUMENTS) {
      const { n, oldest } = stats.get(inst.symbol) as { n: number; oldest: number | null };
      const missing = days - n;
      if (missing <= 0) continue;
      let candles: Candle[];
      if (n === 0 || oldest === null) {
        candles = generateDailyHistory(inst, missing);
      } else {
        const anchor = (oldestOpen.get(inst.symbol, oldest) as { open: number }).open;
        candles = generateDailyHistory(inst, missing, new Date(oldest - 86_400_000), anchor, 1);
      }
      for (const c of candles) insert.run(inst.symbol, c.ts, c.open, c.high, c.low, c.close, c.volume);
      generated += candles.length;
    }
    return generated;
  });
  return tx();
}

export class MarketService extends EventEmitter {
  private provider!: MarketDataProvider;
  private candles = new Map<string, Candle[]>(); // historique quotidien par valeur
  private snapshots = new Map<string, QuoteSnapshot>();
  private intraday = new Map<string, Candle[]>(); // bougies 1 minute de la séance
  private indexBase = new Map<string, number>();
  private lastValue = new Map<string, number>(); // capitaux cumulés (prix * volume approx.)
  private books = new Map<string, OrderBook>();
  private bookRand = mulberry32Seed(Date.now() & 0xffffffff);
  private started = false;
  private statusTimer: NodeJS.Timeout | null = null;

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
    this.statusTimer = setInterval(() => this.emit("status", this.status()), 30_000);
  }

  /** Arrête le flux et les minuteries (tests, arrêt propre). */
  stop(): void {
    this.provider?.stop();
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
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
    const generated = ensureHistoryDepth(this.db, config.historyDays);
    if (generated > 0) {
      console.log(`[market] ${generated} séances d'historique synthétique générées (profondeur cible : ${config.historyDays} séances par valeur)`);
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
      perf: emptyPerf(),
      high52: price,
      low52: price,
    });
    this.refreshPerf(inst.symbol);
  }

  /**
   * Variations par période : 1D par rapport à la clôture de la veille, les autres par rapport à
   * la clôture N séances avant la séance en cours (la bougie du jour est exclue de la référence),
   * YTD par rapport à la dernière clôture de l'année précédente. Plus haut / plus bas 52 semaines.
   */
  private refreshPerf(symbol: string): void {
    const s = this.snapshots.get(symbol);
    if (!s) return;
    const arr = this.candles.get(symbol) ?? [];
    const today = startOfDayUtc(Date.now());
    const hist = arr.length && arr[arr.length - 1].ts >= today ? arr.slice(0, -1) : arr; // clôtures des séances précédentes
    const price = s.price;
    const pct = (ref: number | undefined) => (ref && ref > 0 ? round2((price / ref - 1) * 100) : null);
    const perf = emptyPerf();
    perf["1D"] = pct(s.prevClose);
    for (const [p, n] of Object.entries(PERIOD_SESSIONS) as [Exclude<Period, "1D" | "YTD">, number][]) {
      perf[p] = hist.length >= n ? pct(hist[hist.length - n].close) : null;
    }
    const year = new Date(today).getUTCFullYear();
    const lastPrevYear = [...hist].reverse().find((c) => new Date(c.ts).getUTCFullYear() < year);
    perf.YTD = pct(lastPrevYear?.close);
    const window = arr.slice(-250);
    s.perf = perf;
    s.high52 = window.length ? Math.max(price, ...window.map((c) => c.high)) : price;
    s.low52 = window.length ? Math.min(price, ...window.map((c) => c.low)) : price;
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
        this.refreshPerf(q.symbol);
        updated.push({ ...s, perf: { ...s.perf } });
      }
    });
    tx();
    if (updated.length) {
      const books: OrderBook[] = [];
      for (const q of updated) {
        const inst = INSTRUMENT_MAP.get(q.symbol);
        if (!inst) continue;
        const b = buildOrderBook(inst, q.price, this.bookRand, 5, q.ts);
        this.books.set(q.symbol, b);
        books.push(b);
      }
      this.emit("quotes", updated);
      this.emit("books", books);
      this.emitIndices();
    }
  }

  /** Carnet d'ordres (reconstitué) d'une valeur. */
  orderBook(symbol: string): OrderBook | undefined {
    const existing = this.books.get(symbol);
    if (existing) return existing;
    const inst = INSTRUMENT_MAP.get(symbol);
    const s = this.snapshots.get(symbol);
    if (!inst || !s) return undefined;
    const b = buildOrderBook(inst, s.price, this.bookRand, 5, s.ts);
    this.books.set(symbol, b);
    return b;
  }

  /**
   * Historique quotidien des indices, recalculé à partir des clôtures (même pondération que
   * les indices temps réel). Retourne les `days` dernières séances.
   */
  indexHistory(days = 400): { ts: number; composite: number; brvm30: number }[] {
    const compBase = this.indexBase.get("BRVM Composite") ?? 1;
    const b30Base = this.indexBase.get("BRVM 30") ?? 1;
    // Index par date : close de chaque valeur
    const byDate = new Map<number, Map<string, number>>();
    for (const inst of INSTRUMENTS) {
      const arr = this.candles.get(inst.symbol) ?? [];
      for (const c of arr.slice(-days)) {
        let m = byDate.get(c.ts);
        if (!m) byDate.set(c.ts, (m = new Map()));
        m.set(inst.symbol, c.close);
      }
    }
    const lastKnown = new Map<string, number>();
    const out: { ts: number; composite: number; brvm30: number }[] = [];
    for (const ts of [...byDate.keys()].sort((a, b) => a - b)) {
      const closes = byDate.get(ts)!;
      let comp = 0;
      let b30 = 0;
      for (const inst of INSTRUMENTS) {
        const px = closes.get(inst.symbol) ?? lastKnown.get(inst.symbol) ?? inst.refPrice;
        lastKnown.set(inst.symbol, px);
        const w = px * inst.avgVolume * 50;
        comp += w;
        if (inst.brvm30) b30 += w;
      }
      out.push({ ts, composite: round2(comp / compBase), brvm30: round2(b30 / b30Base) });
    }
    return out.slice(-days);
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

function mulberry32Seed(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

export function emptyPerf(): PeriodPerf {
  return { "1D": null, "1W": null, "1M": null, "3M": null, "6M": null, YTD: null, "1Y": null, "3Y": null, "5Y": null };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
