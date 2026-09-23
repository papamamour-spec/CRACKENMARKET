import { EventEmitter } from "node:events";
import * as cheerio from "cheerio";
import type { DB } from "../db/index.js";
import { NEGATIVE_TERMS, NEWS_ALIASES, POSITIVE_TERMS } from "../data/news_aliases.js";

export interface NewsItem {
  id: number;
  source: string;
  title: string;
  url: string;
  summary: string | null;
  published_at: number;
  symbols: string; // JSON
  sentiment: number; // -1..1
  market_wide: number; // 1 si l'article concerne la place / l'économie régionale
  fetched_at: number;
}

export interface NewsView extends Omit<NewsItem, "symbols"> {
  symbols: string[];
}

export interface NewsSentiment {
  score: number; // -1..1 pondéré par la fraîcheur
  count: number;
  headlines: { title: string; sentiment: number; source: string; url: string; published_at: number }[];
}

export interface NewsSource {
  name: string;
  url: string;
  kind: "rss" | "brvm-html";
}

/** Sources par défaut (modifiables via NEWS_FEEDS=url1,url2 pour les flux RSS). */
export const DEFAULT_SOURCES: NewsSource[] = [
  { name: "BRVM", url: "https://www.brvm.org/fr/actualites", kind: "brvm-html" },
  { name: "Financial Afrik", url: "https://www.financialafrik.com/feed/", kind: "rss" },
  { name: "Sika Finance", url: "https://www.sikafinance.com/rss/actualites", kind: "rss" },
];

const MARKET_TERMS = ["brvm", "bourse regionale", "bourse régionale", "uemoa", "umoa", "bceao", "amf-umoa", "marché financier régional", "marche financier regional", "indice composite"];

export function normalize(text: string): string {
  return ` ${text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")} `;
}

/** Sentiment lexical d'un texte financier : somme pondérée des termes, bornée à [-1, 1]. */
export function scoreSentiment(text: string): number {
  const t = normalize(text);
  let score = 0;
  let hits = 0;
  for (const [term, w] of POSITIVE_TERMS) if (t.includes(normalize(term).trim())) { score += w; hits++; }
  for (const [term, w] of NEGATIVE_TERMS) if (t.includes(normalize(term).trim())) { score += w; hits++; }
  if (!hits) return 0;
  return Math.max(-1, Math.min(1, score / Math.max(2, hits)));
}

const ALIAS_PATTERNS = new Map<string, RegExp[]>(
  Object.entries(NEWS_ALIASES).map(([symbol, aliases]) => [
    symbol,
    [...aliases.map((a) => normalize(a).trim()), symbol.toLowerCase()].map((a) => new RegExp(`(?<![a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`)),
  ]),
);

/** Valeurs mentionnées dans un texte (dictionnaire d'alias, frontières de mots : « Onatel » ne matche pas « Sonatel »). */
export function matchSymbols(text: string): string[] {
  const t = normalize(text);
  const out: string[] = [];
  for (const [symbol, patterns] of ALIAS_PATTERNS) if (patterns.some((re) => re.test(t))) out.push(symbol);
  return out;
}

export function isMarketWide(text: string): boolean {
  const t = normalize(text);
  return MARKET_TERMS.some((m) => t.includes(normalize(m).trim()));
}

export interface ParsedItem {
  title: string;
  url: string;
  summary: string | null;
  publishedAt: number;
}

/** Analyse RSS 2.0 / Atom. */
export function parseRss(xml: string): ParsedItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: ParsedItem[] = [];
  $("item, entry").each((_, el) => {
    const e = $(el);
    const title = e.find("title").first().text().trim();
    const link = e.find("link").first().attr("href") ?? e.find("link").first().text().trim();
    const desc = (e.find("description").first().text() || e.find("summary").first().text() || e.find("content").first().text()).trim();
    const date = e.find("pubDate, published, updated, dc\\:date").first().text().trim();
    if (!title || !link) return;
    const ts = date ? Date.parse(date) : NaN;
    out.push({ title, url: link, summary: desc ? cheerio.load(desc).text().trim().slice(0, 400) : null, publishedAt: Number.isFinite(ts) ? ts : Date.now() });
  });
  return out;
}

/** Analyse de la page « Actualités » du site de la BRVM (liens d'articles). */
export function parseBrvmHtml(html: string, base = "https://www.brvm.org"): ParsedItem[] {
  const $ = cheerio.load(html);
  const out: ParsedItem[] = [];
  const seen = new Set<string>();
  $("a[href*='/fr/actualites/'], a[href*='/fr/content/'], article a").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    const title = $(a).text().trim();
    if (!href || title.length < 12 || seen.has(href)) return;
    seen.add(href);
    const url = href.startsWith("http") ? href : `${base}${href}`;
    const dateText = $(a).closest("article, .views-row, li, div").find("time, .date, .field--name-created").first().text().trim();
    const ts = dateText ? Date.parse(dateText) : NaN;
    out.push({ title, url, summary: null, publishedAt: Number.isFinite(ts) ? ts : Date.now() });
  });
  return out;
}

/**
 * Veille d'actualité : collecte périodique des sources (BRVM, presse financière), rattachement
 * aux valeurs, score de sentiment, et agrégats utilisés pour tempérer les conseils.
 */
export class NewsService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private lastRun: { at: number; ok: string[]; failed: string[] } | null = null;

  constructor(
    private readonly db: DB,
    private readonly sources: NewsSource[] = DEFAULT_SOURCES,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    const extra = process.env.NEWS_FEEDS?.split(",").map((u) => u.trim()).filter(Boolean) ?? [];
    for (const url of extra) this.sources.push({ name: new URL(url).hostname, url, kind: "rss" });
  }

  start(intervalMs = 30 * 60_000): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  status() {
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM news_items").get() as { n: number }).n;
    return { sources: this.sources.map((s) => s.name), items: count, lastRun: this.lastRun };
  }

  async refresh(): Promise<number> {
    const ok: string[] = [];
    const failed: string[] = [];
    let inserted = 0;
    for (const src of this.sources) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12_000);
        const res = await this.fetchImpl(src.url, { signal: ctrl.signal, headers: { "user-agent": "CrackenMarket/0.1 (+veille-actualite)" } });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        const items = src.kind === "rss" ? parseRss(body) : parseBrvmHtml(body);
        inserted += this.ingest(src.name, items);
        ok.push(src.name);
      } catch (e) {
        failed.push(`${src.name} (${(e as Error).message})`);
      }
    }
    this.lastRun = { at: Date.now(), ok, failed };
    if (failed.length) console.warn(`[news] sources injoignables : ${failed.join(", ")}`);
    if (inserted) this.emit("news", inserted);
    return inserted;
  }

  /** Insère les articles nouveaux (dédoublonnés par URL) ; ne garde que ceux liés à la BRVM ou à une valeur. */
  ingest(source: string, items: ParsedItem[]): number {
    const insert = this.db.prepare("INSERT OR IGNORE INTO news_items(source, title, url, summary, published_at, symbols, sentiment, market_wide, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)");
    let n = 0;
    const tx = this.db.transaction(() => {
      for (const it of items) {
        const text = `${it.title}. ${it.summary ?? ""}`;
        const symbols = matchSymbols(text);
        const market = isMarketWide(text);
        if (!symbols.length && !market) continue;
        const info = insert.run(source, it.title, it.url, it.summary, it.publishedAt, JSON.stringify(symbols), scoreSentiment(text), market ? 1 : 0, Date.now());
        n += info.changes;
      }
    });
    tx();
    return n;
  }

  /** Ajout manuel (analyste / admin) : communiqué, avis BRVM, note interne. */
  addManual(source: string, title: string, url: string, summary: string | null, publishedAt = Date.now()): NewsView {
    const text = `${title}. ${summary ?? ""}`;
    const info = this.db
      .prepare("INSERT INTO news_items(source, title, url, summary, published_at, symbols, sentiment, market_wide, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(source, title, url, summary, publishedAt, JSON.stringify(matchSymbols(text)), scoreSentiment(text), isMarketWide(text) ? 1 : 0, Date.now());
    this.emit("news", 1);
    return this.view(this.db.prepare("SELECT * FROM news_items WHERE id = ?").get(Number(info.lastInsertRowid)) as NewsItem);
  }

  latest(limit = 50, symbol?: string): NewsView[] {
    const rows = symbol
      ? (this.db.prepare("SELECT * FROM news_items WHERE symbols LIKE ? ORDER BY published_at DESC LIMIT ?").all(`%"${symbol}"%`, limit) as NewsItem[])
      : (this.db.prepare("SELECT * FROM news_items ORDER BY published_at DESC LIMIT ?").all(limit) as NewsItem[]);
    return rows.map((r) => this.view(r));
  }

  /** Sentiment récent d'une valeur (14 jours, pondéré par la fraîcheur). */
  sentimentFor(symbol: string, days = 14): NewsSentiment {
    const since = Date.now() - days * 86_400_000;
    const rows = this.db.prepare("SELECT * FROM news_items WHERE symbols LIKE ? AND published_at >= ? ORDER BY published_at DESC LIMIT 20").all(`%"${symbol}"%`, since) as NewsItem[];
    return this.aggregate(rows, days);
  }

  /** Sentiment de place (articles marché / économie régionale). */
  marketSentiment(days = 14): NewsSentiment {
    const since = Date.now() - days * 86_400_000;
    const rows = this.db.prepare("SELECT * FROM news_items WHERE market_wide = 1 AND published_at >= ? ORDER BY published_at DESC LIMIT 40").all(since) as NewsItem[];
    return this.aggregate(rows, days);
  }

  /** Sentiment de toutes les valeurs ayant une actualité récente (pour le moteur). */
  sentimentMap(days = 14): Map<string, NewsSentiment> {
    const since = Date.now() - days * 86_400_000;
    const rows = this.db.prepare("SELECT * FROM news_items WHERE published_at >= ? AND symbols != '[]' ORDER BY published_at DESC LIMIT 500").all(since) as NewsItem[];
    const bySymbol = new Map<string, NewsItem[]>();
    for (const r of rows) for (const s of JSON.parse(r.symbols) as string[]) bySymbol.set(s, [...(bySymbol.get(s) ?? []), r]);
    return new Map([...bySymbol.entries()].map(([s, items]) => [s, this.aggregate(items, days)]));
  }

  private aggregate(rows: NewsItem[], days: number): NewsSentiment {
    if (!rows.length) return { score: 0, count: 0, headlines: [] };
    const now = Date.now();
    let num = 0;
    let den = 0;
    for (const r of rows) {
      const age = (now - r.published_at) / 86_400_000;
      const w = Math.max(0.1, 1 - age / days);
      num += r.sentiment * w;
      den += w;
    }
    return {
      score: Math.round((den ? num / den : 0) * 100) / 100,
      count: rows.length,
      headlines: rows.slice(0, 5).map((r) => ({ title: r.title, sentiment: r.sentiment, source: r.source, url: r.url, published_at: r.published_at })),
    };
  }

  private view(r: NewsItem): NewsView {
    return { ...r, symbols: JSON.parse(r.symbols) as string[] };
  }
}
