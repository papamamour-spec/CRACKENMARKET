import { EventEmitter } from "node:events";
import * as cheerio from "cheerio";
import type { DB } from "../db/index.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../data/instruments.js";
import { parseFinancialNotice, parsePublicationDate, valuationMetrics, type FinancialRecord, type ValuationMetrics } from "../engine/fundamentals.js";
import type { MarketService } from "./market.js";
import type { DocumentService } from "./documents.js";
import type { NewsService } from "./news.js";
import type { QualityService } from "./quality.js";
import { pdfToText, type BocService } from "./boc.js";
import { isDisallowed, politeBytes } from "./fetchPolicy.js";

export interface FundamentalInput {
  symbol: string;
  period: string;
  periodEnd?: string | number | null;
  publishedAt?: string | number | null;
  revenue?: number | null;
  netIncome?: number | null;
  equity?: number | null;
  shares?: number | null;
  eps?: number | null;
  dps?: number | null;
  revenueGrowthPct?: number | null;
  netIncomeGrowthPct?: number | null;
  source?: string;
  url?: string | null;
  note?: string | null;
}

interface Row { id: number; symbol: string; period: string; period_end: number; published_at: number | null; revenue: number | null; net_income: number | null; equity: number | null; shares: number | null; eps: number | null; dps: number | null; revenue_growth_pct: number | null; net_income_growth_pct: number | null; source: string; url: string | null; note: string | null; status: "auto" | "analyste"; updated_at: number }

export interface ScanStatus { at: number; inserted: number; fetched: number; failed: number }

export interface CompanyFundamentals {
  symbol: string;
  name: string;
  price: number;
  records: FinancialRecord[];
  metrics: ValuationMetrics;
}

const DAY = 86_400_000;
/** délai supposé entre la fin d'une période et sa publication quand la date de publication est inconnue */
const PUBLICATION_LAG_DAYS = 120;

function periodEndOf(period: string): number | null {
  const m = period.trim().toUpperCase().match(/^(S1|T1|T3)?\s*(20\d{2})$/);
  if (!m) return null;
  const y = Number(m[2]);
  return m[1] === "S1" ? Date.UTC(y, 5, 30) : m[1] === "T1" ? Date.UTC(y, 2, 31) : m[1] === "T3" ? Date.UTC(y, 8, 30) : Date.UTC(y, 11, 31);
}

function dayTs(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Texte lisible d'une page HTML (titre, paragraphes, cellules de tableau). */
export function htmlToPlainText(html: string): string {
  const $ = cheerio.load(html);
  $("script,style,nav,footer,header").remove();
  // un blanc entre les blocs, sinon « Titre » et le paragraphe suivant se collent
  $("p,div,h1,h2,h3,h4,h5,h6,li,td,th,tr,br,section,article").each((_, el) => { $(el).append(" "); });
  return $("body").text().replace(/\s+/g, " ").trim();
}

/**
 * Fondamentaux : chiffre d'affaires, résultat net, capitaux propres, actions, bénéfice et dividende
 * par action, par période et par société. Lus automatiquement dans les publications collectées
 * (titre et résumé, corps du document à la demande), saisis ou importés par les analystes ;
 * ratios de valorisation (PER, P/B, rendement bénéficiaire, ROE, croissance, distribution).
 */
export class FundamentalsService extends EventEmitter {
  private documents: DocumentService | null = null;
  private news: NewsService | null = null;
  private quality: QualityService | null = null;
  private lastScan: ScanStatus | null = null;
  private scanning = false;
  private pending = false;
  /** documents dont le corps a déjà été lu (persisté dans meta pour ne pas les retélécharger après redémarrage) */
  private fetchedUrls: Set<string> | null = null;

  constructor(private readonly db: DB, private readonly market: MarketService, private readonly fetchImpl: typeof fetch = fetch) {
    super();
  }

  private boc: BocService | null = null;

  /** Bulletin officiel : PER publié par la BRVM, repli du rendement bénéficiaire quand aucune publication n'est structurée. */
  attachBoc(b: BocService): void {
    this.boc = b;
  }

  attach(documents: DocumentService | null, news: NewsService | null, quality: QualityService | null): void {
    this.documents = documents;
    this.news = news;
    this.quality = quality;
    // nouvelles publications ou actualités : lecture automatique, corps des documents inclus (en tâche de fond)
    documents?.on("documents", () => void this.scanInBackground(true));
    news?.on("news", () => void this.scanInBackground(false));
  }

  /**
   * Lecture automatique des publications : au démarrage puis toutes les six heures, le corps des
   * documents collectés (PDF ou HTML) est téléchargé dans le respect des délais des sites et analysé.
   * FUNDAMENTALS_FETCH=0 désactive le téléchargement automatique (titres seuls).
   */
  start(): void {
    if (process.env.FUNDAMENTALS_FETCH === "0") return;
    setTimeout(() => void this.scanInBackground(true), 90_000);
    setInterval(() => void this.scanInBackground(true), 6 * 3_600_000);
  }

  /** Une seule lecture à la fois ; une demande arrivée pendant une lecture en déclenche une autre à la fin. */
  private async scanInBackground(fetchBodies: boolean): Promise<void> {
    if (this.scanning) { this.pending = this.pending || fetchBodies; return; }
    this.scanning = true;
    try {
      await this.scan(fetchBodies && process.env.FUNDAMENTALS_FETCH !== "0");
    } catch (e) {
      console.warn(`[fundamentals] lecture automatique : ${(e as Error).message}`);
    } finally {
      this.scanning = false;
      if (this.pending) { this.pending = false; void this.scanInBackground(true); }
    }
  }

  private loadFetched(): Set<string> {
    if (!this.fetchedUrls) {
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'fundamentals_fetched'").get() as { value: string } | undefined;
      let urls: string[] = [];
      try { urls = row ? (JSON.parse(row.value) as string[]) : []; } catch { urls = []; }
      this.fetchedUrls = new Set(urls);
    }
    return this.fetchedUrls;
  }

  private saveFetched(): void {
    const urls = [...(this.fetchedUrls ?? [])].slice(-3000);
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('fundamentals_fetched', ?)").run(JSON.stringify(urls));
  }

  private view(r: Row): FinancialRecord {
    return { id: r.id, symbol: r.symbol, period: r.period, periodEnd: r.period_end, publishedAt: r.published_at, revenue: r.revenue, netIncome: r.net_income, equity: r.equity, shares: r.shares, eps: r.eps, dps: r.dps, revenueGrowthPct: r.revenue_growth_pct, netIncomeGrowthPct: r.net_income_growth_pct, source: r.source, url: r.url, note: r.note, status: r.status, updatedAt: r.updated_at };
  }

  records(symbol?: string): FinancialRecord[] {
    return (this.db.prepare("SELECT * FROM fundamentals WHERE (? IS NULL OR symbol = ?) ORDER BY period_end DESC, symbol").all(symbol ?? null, symbol ?? null) as Row[]).map((r) => this.view(r));
  }

  /**
   * Insertion ou mise à jour partielle. Une lecture automatique ne remplace jamais une valeur saisie
   * par un analyste ; elle complète les champs vides.
   */
  upsert(input: FundamentalInput, userId: number | null): FinancialRecord {
    const symbol = input.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) throw new Error("Valeur inconnue");
    const period = input.period.trim().toUpperCase().replace(/\s+/g, " ");
    const periodEnd = dayTs(input.periodEnd) ?? periodEndOf(period);
    if (periodEnd == null) throw new Error("Période invalide (attendu : 2025, S1 2025, T1 2025 ou T3 2025)");
    const cur = this.db.prepare("SELECT * FROM fundamentals WHERE symbol = ? AND period = ?").get(symbol, period) as Row | undefined;
    const analyst = userId != null;
    const weaker = !analyst && cur?.status === "analyste";
    const pick = <T>(incoming: T | undefined, existing: T | null): T | null => (incoming === undefined ? existing : weaker && existing != null ? existing : incoming);
    const revenue = pick(input.revenue, cur?.revenue ?? null);
    const netIncome = pick(input.netIncome, cur?.net_income ?? null);
    const equity = pick(input.equity, cur?.equity ?? null);
    const shares = pick(input.shares, cur?.shares ?? null);
    const eps = pick(input.eps, cur?.eps ?? null);
    const dps = pick(input.dps, cur?.dps ?? null);
    const rg = pick(input.revenueGrowthPct, cur?.revenue_growth_pct ?? null);
    const ng = pick(input.netIncomeGrowthPct, cur?.net_income_growth_pct ?? null);
    if ([revenue, netIncome, equity, eps, dps, rg, ng].every((v) => v == null)) throw new Error("Aucune donnée financière");
    const publishedAt = pick(input.publishedAt === undefined ? undefined : dayTs(input.publishedAt), cur?.published_at ?? null);
    const status: Row["status"] = analyst || cur?.status === "analyste" ? "analyste" : "auto";
    const source = weaker ? cur!.source : (input.source ?? (analyst ? "analyste" : "auto"));
    this.db
      .prepare(
        `INSERT INTO fundamentals(symbol, period, period_end, published_at, revenue, net_income, equity, shares, eps, dps, revenue_growth_pct, net_income_growth_pct, source, url, note, status, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(symbol, period) DO UPDATE SET period_end=excluded.period_end, published_at=excluded.published_at, revenue=excluded.revenue, net_income=excluded.net_income, equity=excluded.equity, shares=excluded.shares, eps=excluded.eps, dps=excluded.dps, revenue_growth_pct=excluded.revenue_growth_pct, net_income_growth_pct=excluded.net_income_growth_pct, source=excluded.source, url=COALESCE(excluded.url, fundamentals.url), note=COALESCE(excluded.note, fundamentals.note), status=excluded.status, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      )
      .run(symbol, period, periodEnd, publishedAt, revenue, netIncome, equity, shares, eps, dps, rg, ng, source, input.url ?? null, input.note ?? null, status, userId, Date.now());
    this.emit("change", symbol);
    return this.view(this.db.prepare("SELECT * FROM fundamentals WHERE symbol = ? AND period = ?").get(symbol, period) as Row);
  }

  remove(id: number): void {
    const r = this.db.prepare("SELECT symbol FROM fundamentals WHERE id = ?").get(id) as { symbol: string } | undefined;
    if (!r) return;
    this.db.prepare("DELETE FROM fundamentals WHERE id = ?").run(id);
    this.emit("change", r.symbol);
  }

  /**
   * Import en bloc : symbole ; période ; chiffre d'affaires ; résultat net ; capitaux propres ; actions ;
   * BPA ; dividende par action ; date de publication ; source. Montants en FCFA (virgule décimale acceptée).
   */
  importText(text: string, userId: number | null): { imported: FinancialRecord[]; rejected: string[] } {
    const imported: FinancialRecord[] = [];
    const rejected: string[] = [];
    const num = (s: string | undefined) => {
      if (!s || !s.trim()) return null;
      const n = Number(s.replace(/[  ]/g, "").replace(",", "."));
      return Number.isFinite(n) ? n : null;
    };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^symbole/i.test(line)) continue;
      const c = line.split(/[;\t]/).map((x) => x.trim());
      try {
        imported.push(this.upsert({ symbol: c[0], period: c[1], revenue: num(c[2]), netIncome: num(c[3]), equity: num(c[4]), shares: num(c[5]), eps: num(c[6]), dps: num(c[7]), publishedAt: c[8] || null, source: c[9] || "import" }, userId));
      } catch {
        rejected.push(line);
      }
    }
    return { imported, rejected };
  }

  /** Lecture d'un texte (publication) pour une société : enregistre si une période et au moins un montant sont trouvés. */
  ingestText(symbol: string, text: string, url: string | null, source: string, publishedAt: number | null): FinancialRecord | null {
    const sym = symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(sym)) return null;
    const f = parseFinancialNotice(text);
    if (!f.period || [f.revenue, f.netIncome, f.equity, f.eps, f.dps, f.revenueGrowthPct, f.netIncomeGrowthPct].every((v) => v == null)) return null;
    try {
      return this.upsert({ symbol: sym, period: f.period, periodEnd: f.periodEnd, publishedAt: publishedAt ?? parsePublicationDate(text), revenue: f.revenue, netIncome: f.netIncome, equity: f.equity, eps: f.eps, dps: f.dps, revenueGrowthPct: f.revenueGrowthPct, netIncomeGrowthPct: f.netIncomeGrowthPct, source: `auto · ${source}`, url }, null);
    } catch {
      return null;
    }
  }

  /** Corps d'un document (PDF ou HTML), lu dans le respect des délais et interdictions des sites. */
  private async fetchBody(url: string): Promise<string> {
    const { bytes, contentType } = await politeBytes(url, { fetchImpl: this.fetchImpl, timeoutMs: 60_000 });
    const isPdf = contentType.includes("pdf") || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
    const text = isPdf ? await pdfToText(bytes) : htmlToPlainText(new TextDecoder().decode(bytes));
    return text.slice(0, 60_000);
  }

  /**
   * Parcourt les publications collectées (résultats, états financiers, rapports annuels, communiqués)
   * et l'actualité ; avec `fetchBodies`, télécharge le corps des documents (PDF ou HTML) non encore lus.
   */
  async scan(fetchBodies = false, maxFetch = 60): Promise<{ inserted: number; fetched: number; failed: number }> {
    let inserted = 0;
    let fetched = 0;
    let failed = 0;
    const seen = new Set((this.db.prepare("SELECT url FROM fundamentals WHERE url IS NOT NULL").all() as { url: string }[]).map((r) => r.url));
    const done = this.loadFetched();
    // documents les plus récents d'abord, au plus `maxFetch` téléchargements par passage (10 s par requête sur brvm.org)
    for (const kind of ["resultats", "etats_financiers", "rapport_annuel", "communique"] as const) {
      const docs = (this.documents?.list({ kind, limit: 300 }) ?? []).sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0));
      for (const d of docs) {
        let text = `${d.title}. ${d.summary ?? ""}`;
        if (fetchBodies && !seen.has(d.url) && !done.has(d.url) && fetched + failed < maxFetch && !isDisallowed(d.url)) {
          try {
            text += ` ${await this.fetchBody(d.url)}`;
            fetched++;
            done.add(d.url);
          } catch {
            failed++;
          }
        }
        if (this.ingestText(d.symbol, text, d.url, d.source, d.published_at)) inserted++;
      }
    }
    if (fetched) this.saveFetched();
    for (const item of this.news?.latest(300) ?? []) {
      if (!/resultat|chiffre d'affaires|benefice|produit net bancaire/i.test(`${item.title} ${item.summary ?? ""}`.normalize("NFD").replace(/[̀-ͯ]/g, ""))) continue;
      for (const sym of item.symbols) if (this.ingestText(sym, `${item.title}. ${item.summary ?? ""}`, item.url, item.source, item.published_at)) inserted++;
    }
    this.lastScan = { at: Date.now(), inserted, fetched, failed };
    return { inserted, fetched, failed };
  }

  private sharesHint(symbol: string): number | null {
    return this.quality?.profile(symbol).sharesOutstanding ?? null;
  }

  company(symbol: string): CompanyFundamentals {
    const sym = symbol.toUpperCase();
    const inst = INSTRUMENT_MAP.get(sym);
    if (!inst) throw new Error("Valeur inconnue");
    const price = this.market.price(sym) || inst.refPrice;
    const records = this.records(sym);
    return { symbol: sym, name: inst.name, price, records, metrics: valuationMetrics(records, price, this.sharesHint(sym)) };
  }

  /** Ratios de toutes les sociétés qui disposent d'au moins un enregistrement. */
  all(): CompanyFundamentals[] {
    const syms = new Set(this.records().map((r) => r.symbol));
    return INSTRUMENTS.filter((i) => syms.has(i.symbol)).map((i) => this.company(i.symbol));
  }

  /**
   * Rendement bénéficiaire (%) connu à une date : dernier exercice annuel publié avant cette date
   * (date de publication, sinon fin de période + 120 jours). Sert au modèle de panel sans fuite du futur.
   */
  earningsYieldAt(symbol: string, ts: number, price: number): number | null {
    if (!(price > 0)) return null;
    const rows = this.db.prepare("SELECT * FROM fundamentals WHERE symbol = ? AND period GLOB '[0-9][0-9][0-9][0-9]' ORDER BY period_end DESC").all(symbol.toUpperCase()) as Row[];
    const shares = this.sharesHint(symbol);
    for (const r of rows) {
      const known = r.published_at ?? r.period_end + PUBLICATION_LAG_DAYS * DAY;
      if (known > ts) continue;
      const eps = r.eps ?? (r.net_income != null && (r.shares ?? shares) ? r.net_income / (r.shares ?? shares)! : null);
      if (eps != null) return (eps / price) * 100;
    }
    const per = this.boc?.perAt(symbol, ts) ?? null;
    return per != null && per > 0 ? Math.round((100 / per) * 100) / 100 : null;
  }

  status(): { records: number; companies: number; auto: number; lastScan: ScanStatus | null } {
    const a = this.db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT symbol) AS c, SUM(status = 'auto') AS auto FROM fundamentals").get() as { n: number; c: number; auto: number | null };
    return { records: a.n, companies: a.c, auto: a.auto ?? 0, lastScan: this.lastScan };
  }
}
