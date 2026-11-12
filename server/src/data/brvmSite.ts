/**
 * Lecture des pages publiques de brvm.org, vérifiée sur les pages réelles :
 *  - /fr/bulletins-officiels-de-la-cote : liens « boc_AAAAMMJJ(_n).pdf » des bulletins quotidiens ;
 *  - /fr/cours-actions/0 : tableau Symbole, Nom, Volume, Cours veille, Ouverture, Clôture, Variation ;
 *  - /fr/cours-obligations/0 : Code, Nom, Date émission, Date maturité, Cours du jour en valeur,
 *    Coupon couru, Dernier paiement ;
 *  - /fr/rapports-societes-cotees?page=n : index des sociétés (lien /fr/rapports-societe-cotes/slug) ;
 *  - /fr/rapports-societe-cotes/slug : documents PDF (« AAAAMMJJ_-_titre.pdf ») ;
 *  - /fr/mediacentre/actualites : actualités (titre, chapeau, lien) ;
 *  - /fr/emetteurs/type-annonces/… : annonces des émetteurs (PDF datés).
 * Le robots.txt de la BRVM demande un délai de 10 secondes entre deux requêtes : les collecteurs
 * le respectent (voir `services/fetchPolicy.ts`).
 */
import * as cheerio from "cheerio";

export interface BulletinLink { url: string; sessionTs: number; title: string }
export interface BrvmQuoteRow { symbol: string; name: string; volume: number | null; prev: number | null; open: number | null; close: number | null; changePct: number | null }
export interface BrvmBondRow { code: string; name: string; issueDate: number | null; maturityDate: number | null; priceFcfa: number | null; accrued: number | null; lastCouponDate: number | null; lastCouponAmount: number | null }
export interface BrvmCompanyLink { slug: string; url: string; name: string }
export interface BrvmDocument { url: string; title: string; publishedAt: number | null; filename: string }
export interface BrvmNewsItem { title: string; url: string; summary: string | null; publishedAt: number | null }

const num = (t: string | undefined): number | null => {
  if (t == null) return null;
  const s = t.replace(/[  ]/g, "").replace(/%$/, "").replace(",", ".").trim();
  if (!s || s === "-") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};
const frDate = (t: string | undefined): number | null => {
  const m = t?.match(/(\d{1,2})\/(\d{1,2})\/(20\d{2})/);
  return m ? Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
};
const MONTHS: Record<string, number> = { janvier: 0, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11 };
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Liens des bulletins officiels, du plus récent au plus ancien, dédoublonnés par séance (variante « _0 » conservée en priorité). */
export function parseBulletinLinks(html: string, base = "https://www.brvm.org"): BulletinLink[] {
  const $ = cheerio.load(html);
  const bySession = new Map<number, BulletinLink>();
  $("a[href*='boc_']").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    const m = href.match(/boc_(20\d{2})(\d{2})(\d{2})(?:_\d+)*\.pdf/i);
    if (!m) return;
    const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const title = $(a).closest("tr").find("td").first().text().replace(/\s+/g, " ").trim() || `Bulletin du ${m[3]}/${m[2]}/${m[1]}`;
    const url = new URL(href, base).toString();
    const existing = bySession.get(ts);
    // une version corrigée (« _2_0 ») est publiée après la première : on garde la dernière publiée (la première rencontrée dans la liste)
    if (!existing) bySession.set(ts, { url, sessionTs: ts, title });
  });
  return [...bySession.values()].sort((a, b) => b.sessionTs - a.sessionTs);
}

/** Tableau des cours des actions (page « cours-actions »). */
export function parseBrvmQuotes(html: string): BrvmQuoteRow[] {
  const $ = cheerio.load(html);
  const out: BrvmQuoteRow[] = [];
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td").map((__, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
    if (cells.length < 7 || !/^[A-Z]{3,5}$/.test(cells[0])) return;
    out.push({ symbol: cells[0], name: cells[1], volume: num(cells[2]), prev: num(cells[3]), open: num(cells[4]), close: num(cells[5]), changePct: num(cells[6]) });
  });
  return out;
}

/** Tableau des cours des obligations (page « cours-obligations ») : cours en FCFA. */
export function parseBrvmBonds(html: string): BrvmBondRow[] {
  const $ = cheerio.load(html);
  const out: BrvmBondRow[] = [];
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td").map((__, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
    if (cells.length < 6 || !/^[A-Z]{2,7}\.[OS]\d{1,3}$/.test(cells[0])) return;
    const last = cells[6] ?? "";
    const lm = last.match(/(\d{1,2}\/\d{1,2}\/20\d{2})\s*\/\s*([\d\s ,.]+)/);
    out.push({ code: cells[0], name: cells[1], issueDate: frDate(cells[2]), maturityDate: frDate(cells[3]), priceFcfa: num(cells[4]), accrued: num(cells[5]), lastCouponDate: lm ? frDate(lm[1]) : null, lastCouponAmount: lm ? num(lm[2]) : null });
  });
  return out;
}

/** Index des sociétés cotées (page des rapports), avec les liens de pagination. */
export function parseCompanyIndex(html: string, base = "https://www.brvm.org"): { companies: BrvmCompanyLink[]; nextPages: string[] } {
  const $ = cheerio.load(html);
  const companies: BrvmCompanyLink[] = [];
  const seen = new Set<string>();
  $("a[href*='/rapports-societe-cotes/']").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    const slug = href.split("/rapports-societe-cotes/")[1]?.split(/[?#]/)[0];
    const name = $(a).text().replace(/\s+/g, " ").trim();
    if (!slug || !name || seen.has(slug)) return;
    seen.add(slug);
    companies.push({ slug, url: new URL(href, base).toString(), name });
  });
  const nextPages: string[] = [];
  $("a[href*='page=']").each((_, a) => { const href = $(a).attr("href") ?? ""; if (/rapports-societes-cotees\?page=\d+/.test(href)) nextPages.push(new URL(href, base).toString()); });
  return { companies, nextPages: [...new Set(nextPages)] };
}

/** Titre lisible et date à partir du nom de fichier « 20260626_-_etats_financiers_-_exercice_2025_-_erium_ci.pdf ». */
export function documentFromFilename(url: string): BrvmDocument {
  const filename = decodeURIComponent(url.split("/").pop() ?? "");
  const m = filename.match(/^(20\d{2})(\d{2})(\d{2})/);
  const publishedAt = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  const title = filename.replace(/^\d{8}[_-]*/, "").replace(/\.pdf$/i, "").replace(/_-_/g, " - ").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return { url, title: title.charAt(0).toUpperCase() + title.slice(1), publishedAt, filename };
}

/** Documents PDF d'une page société ou d'une page d'annonces. */
export function parseBrvmDocuments(html: string, base = "https://www.brvm.org"): BrvmDocument[] {
  const $ = cheerio.load(html);
  const out: BrvmDocument[] = [];
  const seen = new Set<string>();
  $("a[href$='.pdf'], a[href*='.pdf?']").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    if (!/sites\/default\/files/.test(href)) return;
    const url = new URL(href, base).toString();
    if (seen.has(url)) return;
    seen.add(url);
    const doc = documentFromFilename(url);
    // le titre affiché dans la ligne (colonne de gauche) est préféré au nom de fichier
    const rowTitle = $(a).closest("tr").find("td").first().text().replace(/\s+/g, " ").trim();
    if (rowTitle.length >= 8 && !/t[ée]l[ée]charger/i.test(rowTitle)) doc.title = rowTitle;
    const rowDate = $(a).closest("tr").text().match(/(\d{1,2})\/(\d{1,2})\/(20\d{2})/);
    if (rowDate && doc.publishedAt == null) doc.publishedAt = Date.UTC(Number(rowDate[3]), Number(rowDate[2]) - 1, Number(rowDate[1]));
    out.push(doc);
  });
  return out;
}

/** Actualités du mediacentre : blocs « views-row ». */
export function parseBrvmNews(html: string, base = "https://www.brvm.org"): BrvmNewsItem[] {
  const $ = cheerio.load(html);
  const out: BrvmNewsItem[] = [];
  const seen = new Set<string>();
  $(".views-row").each((_, row) => {
    const a = $(row).find("a[href*='/mediacentre/actualites/']").first();
    const href = a.attr("href");
    if (!href) return;
    const url = new URL(href, base).toString();
    if (seen.has(url)) return;
    const content = $(row).find(".field-content").filter((__, el) => $(el).text().trim().length > 20).first();
    const p = content.find("p").first();
    const summary = p.text().replace(/\s+/g, " ").trim() || null;
    const clone = content.clone();
    clone.find("p, a, img").remove();
    const title = clone.text().replace(/\s+/g, " ").trim();
    if (!title) return;
    seen.add(url);
    const m = norm(`${summary ?? ""}`).match(/(\d{1,2})(?:er)?\s+([a-z]+)\s+(20\d{2})/);
    const publishedAt = m && MONTHS[m[2]] != null ? Date.UTC(Number(m[3]), MONTHS[m[2]], Number(m[1])) : null;
    out.push({ title, url, summary, publishedAt });
  });
  return out;
}

/** Sociétés de l'index des rapports de brvm.org (« /fr/rapports-societe-cotes/{slug} ») → symbole de la cote actions. */
export const BRVM_COMPANY_SLUGS: Record<string, string> = {
  "air-liquide-ci": "SIVC", "bank-africa-bf": "BOABF", "bank-africa-bn": "BOAB", "bank-africa-ci": "BOAC", "bank-africa-ml": "BOAM", "bank-africa-ng": "BOAN", "bank-africa-sn": "BOAS",
  bbgci: "BBGC", "bernabe-ci": "BNBC", "bici-ci": "BICC", biic: "BICB", "bollore-transport-logistics": "SDSC", "cfao-motors-ci": "CFAC", "cie-ci": "CIEC", "coris-bank-international": "CBIBF",
  "crown-siem-ci": "SEMC", "ecobank-ci": "ECOC", "ecobank-tg": "ETIT", "filtisac-ci": "FTSC", lnb: "LNBB", "nei-ceda-ci": "NEIC", "nestle-ci": "NTLC", nsbc: "NSBC", "onatel-bf": "ONTBF",
  oragroup: "ORGT", "orange-ci": "ORAC", "palm-ci": "PALC", "safca-ci": "SAFC", "saph-ci": "SPHC", "servair-abidjan-ci": "ABJC", "setao-ci": "STAC", "sgb-ci": "SGBC", sib: "SIBC", sicable: "CABC",
  sicor: "SICC", sitab: "STBC", smb: "SMBC", sodeci: "SDCC", sogb: "SOGC", solibra: "SLBC", sonatel: "SNTS", sucrivoire: "SCRC", total: "TTLC", "total-senegal-sa": "TTLS",
  "totalenergies-marketing-sn": "TTLS", "tractafric-ci": "PRSC", "unilever-ci": "UNLC", "uniwax-ci": "UNXC", "vivo-energy-ci": "SHEC",
};

/** Pages d'annonces des émetteurs (PDF datés) et type de document associé. */
export const BRVM_ANNOUNCEMENT_PAGES: { url: string; kind: "assemblee" | "communique" | "autre"; name: string }[] = [
  { url: "https://www.brvm.org/fr/emetteurs/type-annonces/convocations-assemblees-generales", kind: "assemblee", name: "BRVM — Convocations aux assemblées" },
  { url: "https://www.brvm.org/fr/emetteurs/type-annonces/communiques", kind: "communique", name: "BRVM — Communiqués des émetteurs" },
  { url: "https://www.brvm.org/fr/emetteurs/type-annonces/changements-de-dirigeants", kind: "communique", name: "BRVM — Changements de dirigeants" },
  { url: "https://www.brvm.org/fr/emetteurs/type-annonces/franchissements-de-seuil", kind: "communique", name: "BRVM — Franchissements de seuil" },
];
