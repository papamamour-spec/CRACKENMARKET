import * as cheerio from "cheerio";
import { INSTRUMENT_MAP } from "../instruments.js";
import type { Candle } from "../../engine/indicators.js";
import type { MarketDataProvider, Quote } from "./types.js";

/**
 * Fournisseur « live » : lit la cote officielle publiée par la BRVM
 * (https://www.brvm.org) et, en secours, la page marché de Sikafinance.
 *
 * La BRVM ne publie pas d'API publique : on analyse le HTML de la page des cours.
 * Les sélecteurs sont regroupés ici pour être adaptés facilement si la mise en page change.
 * Pour un flux officiel (flux SGI / BRVM Data), implémentez simplement `MarketDataProvider`.
 */
const SOURCES = [
  {
    name: "brvm.org",
    url: "https://www.brvm.org/fr/cours-actions/0",
    parse: parseBrvmTable,
  },
  {
    name: "sikafinance",
    url: "https://www.sikafinance.com/marches/aaz",
    parse: parseSikaTable,
  },
];

function toNumber(txt: string): number {
  const cleaned = txt.replace(/\s| /g, "").replace(/,/g, ".").replace(/[^0-9.\-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function parseBrvmTable(html: string, ts: number): Quote[] {
  const $ = cheerio.load(html);
  const out: Quote[] = [];
  $("table tbody tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .map((__, td) => $(td).text().trim())
      .get();
    if (cells.length < 5) return;
    const symbol = cells[0].toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return;
    // colonnes usuelles : Symbole | Nom | Volume | Cours veille | Ouverture | Clôture | Variation
    const volume = toNumber(cells[2]);
    const price = toNumber(cells[5] ?? cells[cells.length - 2]);
    if (!Number.isFinite(price) || price <= 0) return;
    out.push({ symbol, price, volume: Number.isFinite(volume) ? volume : 0, ts, source: "live" });
  });
  return out;
}

function parseSikaTable(html: string, ts: number): Quote[] {
  const $ = cheerio.load(html);
  const out: Quote[] = [];
  $("table tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .map((__, td) => $(td).text().trim())
      .get();
    if (cells.length < 4) return;
    const symbol = cells[0].toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) return;
    const price = toNumber(cells[1]);
    const volume = toNumber(cells[3]);
    if (!Number.isFinite(price) || price <= 0) return;
    out.push({ symbol, price, volume: Number.isFinite(volume) ? volume : 0, ts, source: "live" });
  });
  return out;
}

export class LiveBrvmProvider implements MarketDataProvider {
  readonly name = "live" as const;
  private timer: NodeJS.Timeout | null = null;
  private lastPrices = new Map<string, number>();

  constructor(private readonly pollIntervalMs: number, private readonly fetchImpl: typeof fetch = fetch) {}

  async healthcheck(): Promise<boolean> {
    try {
      const quotes = await this.fetchQuotes();
      return quotes.length > 5;
    } catch {
      return false;
    }
  }

  async fetchQuotes(): Promise<Quote[]> {
    const ts = Date.now();
    let lastErr: unknown = null;
    for (const src of SOURCES) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const res = await this.fetchImpl(src.url, {
          signal: ctrl.signal,
          headers: { "user-agent": "CrackenMarket/0.1 (+market-data-poller)" },
        });
        clearTimeout(t);
        if (!res.ok) throw new Error(`${src.name} HTTP ${res.status}`);
        const quotes = src.parse(await res.text(), ts);
        if (quotes.length > 0) return quotes;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error("aucune source live disponible");
  }

  async fetchDailyHistory(): Promise<Candle[]> {
    // Pas d'historique public : le service marché complète avec l'historique local/synthétique.
    return [];
  }

  async start(onQuotes: (quotes: Quote[]) => void): Promise<void> {
    this.stop();
    const poll = async () => {
      try {
        const quotes = await this.fetchQuotes();
        const changed = quotes.filter((q) => this.lastPrices.get(q.symbol) !== q.price);
        for (const q of quotes) this.lastPrices.set(q.symbol, q.price);
        if (changed.length) onQuotes(changed);
      } catch (e) {
        console.warn("[live] échec de rafraîchissement :", (e as Error).message);
      }
    };
    await poll();
    this.timer = setInterval(poll, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
