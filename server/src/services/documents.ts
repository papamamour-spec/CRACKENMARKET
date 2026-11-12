import { EventEmitter } from "node:events";
import * as cheerio from "cheerio";
import type { DB } from "../db/index.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../data/instruments.js";
import { matchSymbols, normalize, type NewsService } from "./news.js";
import { BRVM_ANNOUNCEMENT_PAGES, BRVM_COMPANY_SLUGS, parseBrvmDocuments, parseCompanyIndex } from "../data/brvmSite.js";
import { parseSikaCommuniques } from "../data/sika.js";
import { politeText } from "./fetchPolicy.js";

export type DocumentKind = "rapport_annuel" | "etats_financiers" | "resultats" | "dividende" | "assemblee" | "note_information" | "communique" | "autre";

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  rapport_annuel: "Rapport annuel",
  etats_financiers: "États financiers",
  resultats: "Communiqué de résultats",
  dividende: "Avis de dividende",
  assemblee: "Assemblée générale",
  note_information: "Note d'information / prospectus",
  communique: "Communiqué",
  autre: "Autre document",
};

export interface CompanyDocument {
  id: number;
  symbol: string;
  title: string;
  kind: DocumentKind;
  period: string | null; // « 2025 », « S1 2025 », « T3 2025 »
  url: string;
  published_at: number | null;
  source: string;
  summary: string | null;
  fetched_at: number;
}

export interface ParsedDocument {
  title: string;
  url: string;
  publishedAt: number | null;
  symbol?: string; // connu d'après la page (page société) ou déduit du titre
  summary?: string | null;
}

export interface DocumentSource {
  name: string;
  /** URL ; `{symbol}` et `{name}` sont remplacés pour une collecte société par société */
  url: string;
  perCompany?: boolean;
  weight?: number;
}

/**
 * Sources vérifiées sur les pages réelles : index des rapports des sociétés cotées de brvm.org (une page
 * par société, PDF datés), annonces des émetteurs (convocations, communiqués, dirigeants, seuils) et
 * communiqués des sociétés relayés par Sika Finance (titres et dates ; leurs PDF ne sont pas téléchargés,
 * leur robots.txt l'interdit). RichBourse refuse l'extraction automatique : non collecté. DOC_SOURCES_JSON
 * ajoute des pages lues avec le lecteur générique de liens.
 */
export const DEFAULT_DOCUMENT_SOURCES: DocumentSource[] = [];
/** Index des rapports des sociétés cotées sur brvm.org (pages société listant les PDF datés). */
export const BRVM_REPORTS_INDEX = "https://www.brvm.org/fr/rapports-societes-cotees";
export const SIKA_COMMUNIQUES = "https://www.sikafinance.com/marches/communiques_brvm";

const MONTHS: Record<string, number> = { janvier: 0, fevrier: 1, février: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6, aout: 7, août: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11, décembre: 11, jan: 0, fev: 1, fév: 1, mar: 2, avr: 3, juil: 6, sept: 8, oct: 9, nov: 10, dec: 11, déc: 11 };

/** Date trouvée dans un texte : AAAA-MM-JJ, JJ/MM/AAAA, « 12 mars 2026 ». */
export function parseDateText(text: string): number | null {
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const fr = text.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
  if (fr) return Date.UTC(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]));
  const lit = normalize(text).match(/(\d{1,2})(?:er)?\s+([a-zé]+)\.?\s+(\d{4})/);
  if (lit && MONTHS[lit[2]] != null) return Date.UTC(Number(lit[3]), MONTHS[lit[2]], Number(lit[1]));
  return null;
}

/** Type de document d'après son titre. */
export function classifyDocument(title: string): DocumentKind {
  const t = normalize(title);
  if (/rapport annuel|rapport d'activite|rapport dactivite|annual report|rapport de gestion/.test(t)) return "rapport_annuel";
  if (/dividende|dividend|detachement|mise en paiement/.test(t)) return "dividende";
  if (/assemblee|ago\b|age\b|convocation|resolutions/.test(t)) return "assemblee";
  if (/note d'information|note dinformation|prospectus|document de reference|offre publique|augmentation de capital|emission/.test(t)) return "note_information";
  if (/etats financiers|comptes (annuels|consolides|semestriels|trimestriels)|bilan|situation (semestrielle|trimestrielle)|financial statements/.test(t)) return "etats_financiers";
  if (/resultat|chiffre d'affaires|chiffre daffaires|performance|activite au|indicateurs/.test(t)) return "resultats";
  if (/communique|avis|information|annonce/.test(t)) return "communique";
  return "autre";
}

/** Période couverte d'après le titre : année, semestre, trimestre. */
export function extractPeriod(title: string): string | null {
  const t = normalize(title);
  const year = t.match(/\b(20\d{2})\b/);
  if (!year) return null;
  const q = t.match(/\b([1-4])(?:er|e|eme|ème)?\s*trimestre|\bt([1-4])\b|\bq([1-4])\b/);
  if (q) return `T${q[1] ?? q[2] ?? q[3]} ${year[1]}`;
  const s = t.match(/\b(1|2)(?:er|e|eme|ème)?\s*semestre|\bs([12])\b|\bh([12])\b/);
  if (s) return `S${s[1] ?? s[2] ?? s[3]} ${year[1]}`;
  if (/premier semestre|1er semestre|semestriel/.test(t)) return `S1 ${year[1]}`;
  if (/neuf mois|9 mois/.test(t)) return `9M ${year[1]}`;
  return year[1];
}

const DOC_HREF = /\.(pdf|docx?|xlsx?)(\?|$)|\/(document|documents|rapport|rapports|publication|publications|communique|communiques|fichier|files|download|telecharger|upload)/i;

/**
 * Extraction générique des documents d'une page : liens vers des fichiers (PDF, Office) ou des pages de
 * documents, avec le titre du lien (ou du bloc parent), la date trouvée à proximité et la société
 * déduite du titre ou imposée par la page.
 */
export function parseDocumentLinks(html: string, pageUrl: string, forcedSymbol?: string): ParsedDocument[] {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);
  const out: ParsedDocument[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, a) => {
    const el = $(a);
    const href = el.attr("href") ?? "";
    let url: URL;
    try { url = new URL(href, base); } catch { return; }
    if (!DOC_HREF.test(url.pathname + url.search)) return;
    const key = url.origin + url.pathname + url.search;
    if (seen.has(key)) return;
    const container = el.closest("tr, li, article, .item, .document, .card, .row, div");
    let title = el.text().replace(/\s+/g, " ").trim();
    if (title.length < 8 || /^(t[ée]l[ée]charger|download|pdf|voir|lire|ouvrir|consulter)$/i.test(title)) title = container.find("h1,h2,h3,h4,h5,strong,b,.title,.titre").first().text().replace(/\s+/g, " ").trim() || container.text().replace(/\s+/g, " ").trim().slice(0, 160);
    if (title.length < 8) return;
    seen.add(key);
    const ctxText = `${container.find("time").attr("datetime") ?? ""} ${container.text()}`;
    const publishedAt = parseDateText(ctxText) ?? parseDateText(title) ?? parseDateText(url.pathname);
    const symbol = forcedSymbol ?? matchSymbols(`${title} ${container.text().slice(0, 300)}`)[0];
    out.push({ title: title.slice(0, 300), url: key, publishedAt, symbol, summary: null });
  });
  return out;
}

/**
 * Collecte des documents des sociétés cotées (rapports annuels, états financiers, communiqués, avis de
 * dividende…) sur RichBourse et la BRVM, stockage en base, classement et rattachement à la veille.
 */
export class DocumentService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private lastRun: { at: number; ok: string[]; failed: string[]; inserted: number } | null = null;
  private news: NewsService | null = null;

  constructor(
    private readonly db: DB,
    private readonly sources: DocumentSource[] = DEFAULT_DOCUMENT_SOURCES,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    if (process.env.DOC_SOURCES_JSON) {
      try {
        for (const s of JSON.parse(process.env.DOC_SOURCES_JSON) as DocumentSource[]) if (s.url && s.name) this.sources.push(s);
      } catch (e) {
        console.warn(`[documents] DOC_SOURCES_JSON invalide : ${(e as Error).message}`);
      }
    }
  }

  /** Les documents collectés alimentent aussi la veille (sentiment des titres de résultats, dividendes…). */
  attachNews(news: NewsService): void {
    this.news = news;
  }

  start(intervalMs = 6 * 3600_000): void {
    setTimeout(() => void this.refresh(), 20_000);
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  status() {
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM company_documents").get() as { n: number }).n;
    const bySymbol = this.db.prepare("SELECT symbol, COUNT(*) AS n, MAX(published_at) AS last FROM company_documents GROUP BY symbol ORDER BY n DESC").all() as { symbol: string; n: number; last: number | null }[];
    const builtIn = [{ name: "BRVM — rapports des sociétés", url: BRVM_REPORTS_INDEX, perCompany: true }, ...BRVM_ANNOUNCEMENT_PAGES.map((p) => ({ name: p.name, url: p.url, perCompany: false })), { name: "Sika Finance — communiqués", url: SIKA_COMMUNIQUES, perCompany: false }];
    return { sources: [...builtIn, ...this.sources.map((s) => ({ name: s.name, url: s.url, perCompany: !!s.perCompany }))], documents: count, companies: bySymbol.length, bySymbol, lastRun: this.lastRun };
  }

  private async fetchText(url: string): Promise<string> {
    return politeText(url, { fetchImpl: this.fetchImpl, timeoutMs: 20_000 });
  }

  /**
   * Rapports des sociétés cotées sur brvm.org : index paginé → page de chaque société connue →
   * PDF datés (titre lisible). Une requête toutes les 10 secondes : la collecte complète prend
   * plusieurs minutes, elle tourne en tâche de fond.
   */
  async refreshBrvmReports(symbols?: string[]): Promise<{ companies: number; inserted: number; failed: string[] }> {
    const failed: string[] = [];
    const companies = new Map<string, { url: string; symbol: string }>();
    const queue = [BRVM_REPORTS_INDEX];
    const seenPages = new Set<string>();
    while (queue.length && seenPages.size < 10) {
      const url = queue.shift()!;
      if (seenPages.has(url)) continue;
      seenPages.add(url);
      try {
        const idx = parseCompanyIndex(await this.fetchText(url));
        for (const c of idx.companies) {
          const symbol = BRVM_COMPANY_SLUGS[c.slug];
          if (symbol && INSTRUMENT_MAP.has(symbol) && (!symbols || symbols.includes(symbol))) companies.set(c.slug, { url: c.url, symbol });
        }
        for (const n of idx.nextPages) if (!seenPages.has(n)) queue.push(n);
      } catch (e) {
        failed.push(`${url} (${(e as Error).message})`);
      }
    }
    let inserted = 0;
    for (const [slug, c] of companies) {
      try {
        const docs = parseBrvmDocuments(await this.fetchText(c.url));
        inserted += this.ingest("BRVM — rapports des sociétés", docs.map((d) => ({ title: d.title, url: d.url, publishedAt: d.publishedAt, symbol: c.symbol, summary: null })));
      } catch (e) {
        failed.push(`${slug} (${(e as Error).message})`);
      }
    }
    return { companies: companies.size, inserted, failed };
  }

  /** Annonces des émetteurs (brvm.org) et communiqués relayés par Sika Finance. */
  async refreshAnnouncements(): Promise<{ inserted: number; failed: string[] }> {
    const failed: string[] = [];
    let inserted = 0;
    for (const page of BRVM_ANNOUNCEMENT_PAGES) {
      try {
        const docs = parseBrvmDocuments(await this.fetchText(page.url));
        inserted += this.ingest(page.name, docs.map((d) => ({ title: d.title, url: d.url, publishedAt: d.publishedAt, symbol: matchSymbols(`${d.title} ${d.filename.replace(/_/g, " ")}`)[0], summary: null })));
      } catch (e) {
        failed.push(`${page.name} (${(e as Error).message})`);
      }
    }
    try {
      const coms = parseSikaCommuniques(await this.fetchText(SIKA_COMMUNIQUES));
      inserted += this.ingest("Sika Finance — communiqués", coms.filter((c) => c.url).map((c) => ({ title: c.title.replace(/\s*_\s*/g, " — "), url: c.url!, publishedAt: c.date, symbol: matchSymbols(c.title)[0], summary: null })));
    } catch (e) {
      failed.push(`Sika Finance — communiqués (${(e as Error).message})`);
    }
    return { inserted, failed };
  }

  /** Collecte de toutes les sources (sources société par société : une page par valeur, pagination « ?page=n » pour les listes). */
  async refresh(symbols: string[] = INSTRUMENTS.map((i) => i.symbol)): Promise<number> {
    const ok: string[] = [];
    const failed: string[] = [];
    let inserted = 0;
    if (process.env.DOC_COLLECT !== "0") {
      const a = await this.refreshAnnouncements();
      inserted += a.inserted;
      failed.push(...a.failed);
      if (!a.failed.length) ok.push("BRVM — annonces et Sika — communiqués");
      const r = await this.refreshBrvmReports(symbols.length === INSTRUMENTS.length ? undefined : symbols);
      inserted += r.inserted;
      failed.push(...r.failed);
      if (r.companies) ok.push(`BRVM — rapports des sociétés (${r.companies} sociétés)`);
    }
    for (const src of this.sources) {
      try {
        if (src.perCompany) {
          let n = 0;
          let errors = 0;
          for (const sym of symbols) {
            const inst = INSTRUMENT_MAP.get(sym);
            if (!inst) continue;
            const url = src.url.replace("{symbol}", encodeURIComponent(sym)).replace("{name}", encodeURIComponent(inst.name));
            try {
              const docs = parseDocumentLinks(await this.fetchText(url), url, sym);
              n += this.ingest(src.name, docs);
            } catch {
              errors++;
            }
          }
          if (errors === symbols.length) throw new Error("aucune page société joignable");
          inserted += n;
        } else {
          let n = 0;
          for (let page = 0; page < 20; page++) {
            const url = page === 0 ? src.url : `${src.url}${src.url.includes("?") ? "&" : "?"}page=${page}`;
            const docs = parseDocumentLinks(await this.fetchText(url), url);
            if (!docs.length) break;
            const added = this.ingest(src.name, docs);
            n += added;
            if (page > 0 && added === 0) break; // page déjà connue : l'historique est à jour
          }
          inserted += n;
        }
        ok.push(src.name);
      } catch (e) {
        failed.push(`${src.name} (${(e as Error).message})`);
      }
    }
    this.lastRun = { at: Date.now(), ok, failed, inserted };
    if (failed.length) console.warn(`[documents] sources injoignables : ${failed.join(", ")}`);
    if (inserted) this.emit("documents", inserted);
    return inserted;
  }

  /** Insère les documents nouveaux (dédoublonnés par URL), rattachés à une société connue. */
  ingest(source: string, docs: ParsedDocument[]): number {
    const ins = this.db.prepare("INSERT OR IGNORE INTO company_documents(symbol, title, kind, period, url, published_at, source, summary, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)");
    let n = 0;
    const forNews: { title: string; url: string; summary: string | null; publishedAt: number }[] = [];
    const tx = this.db.transaction(() => {
      for (const d of docs) {
        const symbol = (d.symbol ?? matchSymbols(d.title)[0])?.toUpperCase();
        if (!symbol || !INSTRUMENT_MAP.has(symbol)) continue;
        const kind = classifyDocument(d.title);
        const info = ins.run(symbol, d.title, kind, extractPeriod(d.title), d.url, d.publishedAt, source, d.summary ?? null, Date.now());
        if (info.changes) {
          n++;
          if (kind === "resultats" || kind === "dividende" || kind === "communique") forNews.push({ title: `${INSTRUMENT_MAP.get(symbol)!.name} : ${d.title}`, url: d.url, summary: d.summary ?? null, publishedAt: d.publishedAt ?? Date.now() });
        }
      }
    });
    tx();
    if (forNews.length && this.news) this.news.ingest(`Documents · ${source}`, forNews, 1);
    return n;
  }

  /** Import par collage : « SYMBOLE ; titre ; url ; date (facultatif) ; type (facultatif) ». */
  importText(text: string, source = "saisie manuelle"): { inserted: number; rejected: string[] } {
    const docs: ParsedDocument[] = [];
    const rejected: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^(symbole|valeur)/i.test(line)) continue;
      const c = line.split(/\s*;\s*|\t+/).map((x) => x.trim());
      const symbol = c[0]?.toUpperCase();
      const title = c[1];
      const url = c[2];
      if (!symbol || !INSTRUMENT_MAP.has(symbol) || !title || !url || !/^https?:\/\//.test(url)) {
        rejected.push(line);
        continue;
      }
      docs.push({ symbol, title, url, publishedAt: c[3] ? parseDateText(c[3]) : null, summary: null });
    }
    return { inserted: this.ingest(source, docs), rejected };
  }

  list(opts: { symbol?: string; kind?: DocumentKind; limit?: number; q?: string } = {}): CompanyDocument[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.symbol) { where.push("symbol = ?"); params.push(opts.symbol.toUpperCase()); }
    if (opts.kind) { where.push("kind = ?"); params.push(opts.kind); }
    if (opts.q) { where.push("LOWER(title) LIKE ?"); params.push(`%${opts.q.toLowerCase()}%`); }
    params.push(Math.min(500, opts.limit ?? 100));
    return this.db.prepare(`SELECT * FROM company_documents ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC LIMIT ?`).all(...params) as CompanyDocument[];
  }

  /** Historique d'une société groupé par période (année) et type. */
  history(symbol: string): { symbol: string; name: string; total: number; years: { year: string; documents: CompanyDocument[] }[]; kinds: Record<string, number>; latestResults: CompanyDocument | null; latestAnnualReport: CompanyDocument | null } {
    const docs = this.list({ symbol, limit: 500 });
    const byYear = new Map<string, CompanyDocument[]>();
    const kinds: Record<string, number> = {};
    for (const d of docs) {
      const y = d.period?.match(/(20\d{2})/)?.[1] ?? (d.published_at ? String(new Date(d.published_at).getUTCFullYear()) : "Sans date");
      byYear.set(y, [...(byYear.get(y) ?? []), d]);
      kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
    }
    return {
      symbol: symbol.toUpperCase(),
      name: INSTRUMENT_MAP.get(symbol.toUpperCase())?.name ?? symbol,
      total: docs.length,
      years: [...byYear.entries()].sort((a, b) => (b[0] > a[0] ? 1 : -1)).map(([year, documents]) => ({ year, documents })),
      kinds,
      latestResults: docs.find((d) => d.kind === "resultats" || d.kind === "etats_financiers") ?? null,
      latestAnnualReport: docs.find((d) => d.kind === "rapport_annuel") ?? null,
    };
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM company_documents WHERE id = ?").run(id);
  }
}
