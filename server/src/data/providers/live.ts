import { INSTRUMENT_MAP } from "../instruments.js";
import { parseBrvmQuotes } from "../brvmSite.js";
import { parseSikaQuoteList } from "../sika.js";
import { politeFetch } from "../../services/fetchPolicy.js";
import type { Candle } from "../../engine/indicators.js";
import type { MarketDataProvider, Quote } from "./types.js";

/**
 * Fournisseur « live » : lit la cote officielle publiée par la BRVM
 * (https://www.brvm.org) et, en secours, la page marché de Sikafinance.
 *
 * La BRVM ne publie pas d'API publique : on lit le tableau HTML de la page des cours (format vérifié
 * sur la page réelle, voir `data/brvmSite.ts`) ; la liste de A à Z de Sika Finance sert de secours.
 * Les requêtes passent par `services/fetchPolicy.ts` (délais demandés par les sites).
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

/** Page des cours de la BRVM (tableau Symbole, Nom, Volume, Veille, Ouverture, Clôture, Variation), vérifiée sur la page réelle. */
function parseBrvmTable(html: string, ts: number): Quote[] {
  return parseBrvmQuotes(html).filter((r) => INSTRUMENT_MAP.has(r.symbol) && r.close != null && r.close > 0).map((r) => ({ symbol: r.symbol, price: r.close!, volume: r.volume ?? 0, ts, source: "live" as const }));
}

/** Cotations de A à Z de Sika Finance (symbole lu dans le lien de chaque ligne), vérifiée sur la page réelle. */
function parseSikaTable(html: string, ts: number): Quote[] {
  return parseSikaQuoteList(html).filter((r) => INSTRUMENT_MAP.has(r.symbol) && r.last != null && r.last > 0).map((r) => ({ symbol: r.symbol, price: r.last!, volume: r.volume ?? 0, ts, source: "live" as const }));
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
        const res = await politeFetch(src.url, { fetchImpl: this.fetchImpl, timeoutMs: 20000 });
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
