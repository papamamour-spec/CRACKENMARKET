/**
 * Lecture des pages publiques de Sika Finance (sikafinance.com), vérifiée sur les pages réelles :
 *  - /marches/aaz : cotations de A à Z (liens « cotation_SYM.cc » → symbole, ouverture, haut, bas,
 *    volume en titres, volume en FCFA, dernier, variation) ;
 *  - /marches/historiques/SYM.cc : historique des séances (date, clôture, bas, haut, ouverture,
 *    volumes, variation), environ trois mois par page ;
 *  - /marches/dividendes : dividendes à venir (date de détachement, montant) et historique par
 *    exercice (Div. 2022 … 2025, rendements) ;
 *  - /marches/cotation_SYM.cc : fiche d'une valeur (valorisation en millions de FCFA, dividendes
 *    par année) ;
 *  - /marches/communiques_brvm : communiqués des sociétés (date, titre, lien PDF) ;
 *  - /marches/actualites_bourse_brvm : actualités du marché (titre, chapeau, date).
 * Les documents PDF de Sika (/docs/…) ne sont jamais téléchargés : leur robots.txt l'interdit.
 */
import * as cheerio from "cheerio";
import type { Candle } from "../engine/indicators.js";

export interface SikaQuote { symbol: string; suffix: string; name: string; open: number | null; high: number | null; low: number | null; volume: number | null; value: number | null; last: number | null; changePct: number | null }
export interface SikaDividendHistory { symbol: string; name: string; byYear: { year: number; amount: number; yieldPct: number | null }[] }
export interface SikaUpcomingDividend { symbol: string | null; name: string; exDate: number | null; amount: number | null; yieldPct: number | null }
export interface SikaCommunique { date: number | null; title: string; url: string | null; company: string | null }
export interface SikaNews { title: string; url: string; summary: string | null; publishedAt: number | null }
export interface SikaCompanyPage { marketCapFcfa: number | null; dividends: { year: number; amount: number; yieldPct: number | null }[]; beta: number | null }

const num = (t: string | undefined): number | null => {
  if (t == null) return null;
  const s = t.replace(/[  ]/g, "").replace(/%$/, "").replace(",", ".").trim();
  if (!s || s === "-") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};
const SYM_RE = /cotation_([A-Z0-9]+)\.([a-z]{2})(?:$|[?#])/;

export function parseSymbolHref(href: string | undefined): { symbol: string; suffix: string } | null {
  const m = href?.match(SYM_RE);
  return m ? { symbol: m[1], suffix: m[2] } : null;
}

/** Date « 11/11/2026 » ou ISO. */
export function parseSikaDate(t: string | undefined): number | null {
  if (!t) return null;
  const fr = t.match(/(\d{1,2})\/(\d{1,2})\/(20\d{2})/);
  if (fr) return Date.UTC(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]));
  const iso = t.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  return null;
}

/** Cotations de A à Z : seules les lignes dont le lien désigne une valeur (pas un indice) sont retenues. */
export function parseSikaQuoteList(html: string): SikaQuote[] {
  const $ = cheerio.load(html);
  const out: SikaQuote[] = [];
  $("table tr").each((_, tr) => {
    const a = $(tr).find("a[href*='cotation_']").first();
    const sym = parseSymbolHref(a.attr("href"));
    const cells = $(tr).find("td").map((__, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
    if (!sym || cells.length < 8) return;
    out.push({ symbol: sym.symbol, suffix: sym.suffix, name: a.text().replace(/\s+/g, " ").trim(), open: num(cells[1]), high: num(cells[2]), low: num(cells[3]), volume: num(cells[4]), value: num(cells[5]), last: num(cells[6]), changePct: num(cells[7]) });
  });
  return out;
}

/** Historique d'une valeur : bougies quotidiennes (ordre chronologique). */
export function parseSikaHistory(html: string): Candle[] {
  const $ = cheerio.load(html);
  const out: Candle[] = [];
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td").map((__, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
    if (cells.length < 6) return;
    const ts = parseSikaDate(cells[0]);
    const close = num(cells[1]);
    if (ts == null || close == null || close <= 0) return;
    const low = num(cells[2]) ?? close;
    const high = num(cells[3]) ?? close;
    const open = num(cells[4]) ?? close;
    const volume = num(cells[5]) ?? 0;
    out.push({ ts, open, high: Math.max(high, open, close), low: Math.min(low, open, close), close, volume: Math.round(volume) });
  });
  return out.sort((a, b) => a.ts - b.ts);
}

/** Page des dividendes : historique par exercice (colonnes « Div. AAAA ») et détachements à venir. */
export function parseSikaDividends(html: string): { history: SikaDividendHistory[]; upcoming: SikaUpcomingDividend[] } {
  const $ = cheerio.load(html);
  const history: SikaDividendHistory[] = [];
  const upcoming: SikaUpcomingDividend[] = [];
  $("table").each((_, table) => {
    const head = $(table).find("tr").first().find("th,td").map((__, c) => $(c).text().replace(/\s+/g, " ").trim()).get();
    const yearCols = head.map((h, i) => ({ i, y: Number((h.match(/Div\.?\s*(20\d{2})/) ?? [])[1]) })).filter((c) => Number.isFinite(c.y) && c.y > 2000);
    if (yearCols.length) {
      $(table).find("tr").slice(1).each((__, tr) => {
        const a = $(tr).find("a[href*='cotation_']").first();
        const sym = parseSymbolHref(a.attr("href"));
        const cells = $(tr).find("td").map((___, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
        if (!sym || cells.length < 3) return;
        const byYear = yearCols.map((c) => ({ year: c.y, amount: num(cells[c.i]), yieldPct: num(cells[c.i + 1]) })).filter((d): d is { year: number; amount: number; yieldPct: number | null } => d.amount != null && d.amount > 0);
        history.push({ symbol: sym.symbol, name: a.text().replace(/\s+/g, " ").trim(), byYear });
      });
    } else if (/d[ée]tachement/i.test(head[0] ?? "")) {
      $(table).find("tr").slice(1).each((__, tr) => {
        const a = $(tr).find("a[href*='cotation_']").first();
        const sym = parseSymbolHref(a.attr("href"));
        const cells = $(tr).find("td").map((___, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
        if (cells.length < 3) return;
        upcoming.push({ symbol: sym?.symbol ?? null, name: cells[1], exDate: parseSikaDate(cells[0]), amount: num(cells[2]), yieldPct: num(cells[3]) });
      });
    }
  });
  return { history, upcoming };
}

/** Fiche d'une valeur : valorisation (« 4 190 000 MXOF » = millions de FCFA), bêta, dividendes par année. */
export function parseSikaCompanyPage(html: string): SikaCompanyPage {
  const $ = cheerio.load(html);
  let marketCapFcfa: number | null = null;
  let beta: number | null = null;
  const dividends: SikaCompanyPage["dividends"] = [];
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td,th").map((__, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
    if (cells.length < 2) return;
    if (/^Valorisation/i.test(cells[0])) { const v = num(cells[1].replace(/MXOF.*$/i, "")); if (v != null) marketCapFcfa = v * 1e6; }
    if (/^Beta/i.test(cells[0])) beta = num(cells[1]);
    if (/^20\d{2}$/.test(cells[0]) && cells.length >= 2) { const amount = num(cells[1]); if (amount != null && amount > 0) dividends.push({ year: Number(cells[0]), amount, yieldPct: num(cells[2]) }); }
  });
  return { marketCapFcfa, dividends, beta };
}

/** Communiqués des sociétés : « SOCIETE : CODE _ Titre » avec lien PDF (jamais téléchargé). */
export function parseSikaCommuniques(html: string, base = "https://www.sikafinance.com"): SikaCommunique[] {
  const $ = cheerio.load(html);
  const out: SikaCommunique[] = [];
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 2) return;
    const date = parseSikaDate($(cells[0]).text());
    const a = $(cells[1]).find("a").first();
    const title = (a.text() || $(cells[1]).text()).replace(/\s+/g, " ").trim();
    if (!title) return;
    const href = a.attr("href");
    const company = title.split(" : ")[0]?.trim() || null;
    out.push({ date, title, url: href ? new URL(href, base).toString() : null, company });
  });
  return out;
}

/** Actualités du marché : éléments « news-item ». */
export function parseSikaNews(html: string, base = "https://www.sikafinance.com"): SikaNews[] {
  const $ = cheerio.load(html);
  const out: SikaNews[] = [];
  const seen = new Set<string>();
  $("li.news-item, .news-item").each((_, li) => {
    const a = $(li).find("a.news-title").first();
    const href = a.attr("href") ?? $(li).find("a[href]").first().attr("href");
    const title = (a.text() || $(li).find("a[aria-label]").first().attr("aria-label") || "").replace(/\s+/g, " ").trim();
    if (!href || !title || seen.has(href)) return;
    seen.add(href);
    const summary = $(li).find(".news-chapeau").first().text().replace(/\s+/g, " ").trim() || null;
    const time = $(li).find("time").first();
    const publishedAt = parseSikaDate(time.attr("datetime")) ?? parseSikaDate(time.text());
    out.push({ title, url: new URL(href, base).toString(), summary, publishedAt });
  });
  return out;
}
