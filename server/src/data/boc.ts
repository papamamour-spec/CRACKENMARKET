/**
 * Lecture du bulletin officiel de la cote (BOC) de la BRVM, compartiment actions.
 *
 * Le bulletin est publié chaque séance (PDF, parfois tableau HTML). Il apporte ce que la page des
 * cours ne donne pas : nombre de transactions, meilleures limites (demande et offre, prix et
 * quantités), titres réservés à la hausse ou à la baisse, titres suspendus. Le parseur accepte :
 *  - un tableau à séparateurs (« ; » ou tabulation, copié d'un tableur ou d'une page web) dont la
 *    première ligne nomme les colonnes ;
 *  - un texte à blancs (extraction d'un PDF) dont une ligne d'en-tête nomme les colonnes ; à défaut
 *    d'en-tête reconnu, la disposition par défaut est celle de la page des cours de la BRVM
 *    (volume, cours veille, ouverture, clôture, variation), configurable par `BOC_COLUMNS`.
 * Chaque ligne commence par le symbole (code BRVM) ; le libellé qui suit est ignoré ; les nombres
 * sont lus dans l'ordre des colonnes ; « RH » / « RB » marquent une réservation, « SUSP » une suspension.
 */
import { INSTRUMENT_MAP } from "./instruments.js";

export type BocField = "ref" | "open" | "high" | "low" | "close" | "changePct" | "volume" | "value" | "trades" | "bid" | "bidQty" | "ask" | "askQty" | "skip";

export interface BocRow {
  symbol: string;
  ref: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  changePct: number | null;
  volume: number | null;
  value: number | null;
  trades: number | null;
  bid: number | null;
  bidQty: number | null;
  ask: number | null;
  askQty: number | null;
  reserved: "up" | "down" | null;
  suspended: boolean;
}

export interface BocParseResult {
  /** séance détectée dans le texte (début de journée UTC), null si absente */
  sessionTs: number | null;
  rows: BocRow[];
  layout: BocField[];
  layoutSource: "header" | "config" | "default";
  unrecognized: number;
}

export const DEFAULT_LAYOUT: BocField[] = ["volume", "ref", "open", "close", "changePct"];
export const BOC_FIELDS: BocField[] = ["ref", "open", "high", "low", "close", "changePct", "volume", "value", "trades", "bid", "bidQty", "ask", "askQty", "skip"];

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Mots-clés d'en-tête, dans l'ordre de priorité de reconnaissance. */
const HEADER_KEYS: { field: BocField; re: RegExp }[] = [
  { field: "trades", re: /nb(?:re|\.)? ?(?:de )?trans|nombre de trans|transactions|nb ?ope/g },
  { field: "changePct", re: /variation|var\.? ?%|var\b/g },
  { field: "ref", re: /cours (?:de )?(?:la )?veille|cours (?:de )?ref(?:erence)?|veille|reference|precedent/g },
  { field: "open", re: /ouverture|ouv\b/g },
  { field: "close", re: /cl[o]ture|clot\b|dernier cours|dernier/g },
  { field: "high", re: /plus haut|\bhaut\b/g },
  { field: "low", re: /plus bas|\bbas\b/g },
  { field: "value", re: /valeur(?:s)? (?:transig|echang|negoc)|capitaux|montant|valeur\b/g },
  { field: "volume", re: /volume|nb(?:re|\.)? ?(?:de )?titres|nombre de titres|titres (?:transig|echang|negoc)|quantite(?:s)? (?:transig|echang)|vol\b/g },
  { field: "bid", re: /meilleure demande|demande|achat|bid/g },
  { field: "ask", re: /meilleure offre|offre|vente|ask/g },
];
const QTY_RE = /qt[e]s?\b|quantite|qte|quantity/g;

function parseNumber(tok: string): number | null {
  const t = tok.replace(/[  ]/g, "").replace(/%$/, "");
  if (!t || t === "-" || t === "--" || /^n\/?[ad]$/i.test(t)) return null;
  // 1.250,50 (séparateur de milliers « . ») ou 1 250,50 ou 1250.5
  let n: number;
  if (/^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) n = Number(t.replace(/\./g, "").replace(",", "."));
  else if (/^[+-]?\d+(,\d+)?$/.test(t)) n = Number(t.replace(",", "."));
  else if (/^[+-]?\d+(\.\d+)?$/.test(t)) n = Number(t);
  else return null;
  return Number.isFinite(n) ? n : null;
}

const isNumToken = (tok: string) => /^[+-]?[\d.,]+%?$/.test(tok) || tok === "-" || tok === "--";

/** Fusionne les groupes de milliers séparés par un blanc (« 28 125 000 » → « 28125000 »). */
function mergeThousands(tokens: string[]): string[] {
  const out: string[] = [];
  let merged = false; // le dernier jeton résulte d'une fusion (« 28 125 » → attend « 000 »)
  for (const tok of tokens) {
    const prev = out[out.length - 1];
    const head = prev != null && /^[+-]?\d{1,3}$/.test(prev);
    if ((head || merged) && /^\d{3}$/.test(tok)) {
      out[out.length - 1] = prev + tok;
      merged = true;
    } else {
      out.push(tok);
      merged = false;
    }
  }
  return out;
}

/** Disposition des colonnes d'après une ligne d'en-tête (null si moins de deux colonnes reconnues). */
export function layoutFromHeader(line: string): BocField[] | null {
  // « Symbole Valeur … », « Code Titre … » : le libellé de la société n'est pas une colonne de cote
  const h = norm(line).replace(/[()]/g, " ").replace(/^\s*(symbole|code|ticker|isin)\s+(valeur|titre|libelle|nom|societe)\b/, "$1 ");
  const found: { pos: number; field: BocField }[] = [];
  const taken: [number, number][] = [];
  const free = (a: number, b: number) => taken.every(([x, y]) => b <= x || a >= y);
  for (const { field, re } of HEADER_KEYS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(h))) {
      if (!free(m.index, m.index + m[0].length)) continue;
      found.push({ pos: m.index, field });
      taken.push([m.index, m.index + m[0].length]);
    }
  }
  QTY_RE.lastIndex = 0;
  let q: RegExpExecArray | null;
  while ((q = QTY_RE.exec(h))) {
    if (!free(q.index, q.index + q[0].length)) continue;
    // quantité rattachée à la limite (demande / offre) qui la précède ; sinon, c'est le volume
    const before = found.filter((f) => f.pos < q!.index && (f.field === "bid" || f.field === "ask")).sort((a, b) => b.pos - a.pos)[0];
    found.push({ pos: q.index, field: before ? (before.field === "bid" ? "bidQty" : "askQty") : "volume" });
    taken.push([q.index, q.index + q[0].length]);
  }
  found.sort((a, b) => a.pos - b.pos);
  const layout = found.map((f) => f.field);
  const distinct = new Set(layout.filter((f) => f !== "skip"));
  return distinct.size >= 2 ? layout : null;
}

/** Tableau à séparateurs : un champ par cellule d'en-tête (« skip » pour symbole, libellé et colonnes inconnues). */
export function layoutFromCells(cells: string[]): BocField[] | null {
  const layout = cells.map((c): BocField => {
    const h = norm(c).trim();
    if (/^(symbole|code|ticker|titre|libelle|nom|societe|valeur|isin)$/.test(h) || /^code /.test(h)) return "skip";
    QTY_RE.lastIndex = 0;
    const qty = QTY_RE.test(h);
    if (qty && /demande|achat|bid/.test(h)) return "bidQty";
    if (qty && /offre|vente|ask/.test(h)) return "askQty";
    if (qty) return "volume";
    for (const { field, re } of HEADER_KEYS) {
      re.lastIndex = 0;
      if (re.test(h)) return field;
    }
    return "skip";
  });
  return new Set(layout.filter((f) => f !== "skip")).size >= 2 ? layout : null;
}

export function parseLayoutConfig(cfg: string | undefined): BocField[] | null {
  if (!cfg) return null;
  const fields = cfg.split(",").map((s) => s.trim()).filter(Boolean) as BocField[];
  return fields.length && fields.every((f) => BOC_FIELDS.includes(f)) ? fields : null;
}

const MONTHS: Record<string, number> = { janvier: 0, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11 };

/** Date de séance mentionnée dans le texte (« séance du 10/11/2026 », « du 10 novembre 2026 », « 2026-11-10 »). */
export function detectSessionDate(text: string): number | null {
  const t = norm(text);
  const near = t.match(/(?:seance|bulletin|cote|journee|date)[^\n]{0,40}?(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (near) return Date.UTC(Number(near[3]), Number(near[2]) - 1, Number(near[1]));
  const lit = t.match(/(?:seance|bulletin|cote|journee|date)[^\n]{0,40}?(\d{1,2})(?:er)?\s+([a-z]+)\s+(\d{4})/);
  if (lit && MONTHS[lit[2]] != null) return Date.UTC(Number(lit[3]), MONTHS[lit[2]], Number(lit[1]));
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const any = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (any) return Date.UTC(Number(any[3]), Number(any[2]) - 1, Number(any[1]));
  return null;
}

function emptyRow(symbol: string): BocRow {
  return { symbol, ref: null, open: null, high: null, low: null, close: null, changePct: null, volume: null, value: null, trades: null, bid: null, bidQty: null, ask: null, askQty: null, reserved: null, suspended: false };
}

function assign(row: BocRow, layout: BocField[], numbers: (number | null)[]): void {
  layout.forEach((f, i) => {
    if (f === "skip" || i >= numbers.length) return;
    row[f] = numbers[i];
  });
}

/**
 * Lit un bulletin (texte). `configLayout` (variable `BOC_COLUMNS`) s'applique aux lignes à blancs
 * sans en-tête reconnu ; un en-tête reconnu a toujours priorité.
 */
export function parseBocText(text: string, configLayout: BocField[] | null = null): BocParseResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sessionTs = detectSessionDate(text);
  let layout: BocField[] = configLayout ?? DEFAULT_LAYOUT;
  let layoutSource: BocParseResult["layoutSource"] = configLayout ? "config" : "default";
  /** disposition par cellule pour un tableau à séparateurs (symbole et libellé inclus) */
  let cellLayout: BocField[] | null = null;
  const rows: BocRow[] = [];
  let unrecognized = 0;
  for (const line of lines) {
    const sep = /;|\t/.test(line) ? /\s*[;\t]\s*/ : null;
    const cells = sep ? line.split(sep) : line.split(/\s+/);
    const symIdx = cells.slice(0, 2).findIndex((c) => INSTRUMENT_MAP.has(c.toUpperCase().replace(/[^A-Z0-9]/g, "")));
    if (symIdx < 0) {
      // ligne d'en-tête ?
      if (sep) {
        const fromCells = layoutFromCells(cells);
        if (fromCells) { cellLayout = fromCells; layoutSource = "header"; layout = fromCells.filter((f) => f !== "skip"); }
      } else {
        const fromHeader = layoutFromHeader(line);
        if (fromHeader) { layout = fromHeader; layoutSource = "header"; }
      }
      continue;
    }
    const first = cells[symIdx].toUpperCase().replace(/[^A-Z0-9]/g, "");
    const row = emptyRow(first);
    const upper = line.toUpperCase();
    if (/\bRH\b|RESERV[ÉE]E? ?(À|A) LA HAUSSE/.test(upper)) row.reserved = "up";
    else if (/\bRB\b|RESERV[ÉE]E? ?(À|A) LA BAISSE/.test(upper)) row.reserved = "down";
    if (/\bSUSP(ENDU|ENSION|\.)?\b/.test(upper)) row.suspended = true;
    let numbers: (number | null)[];
    let rowLayout = layout;
    if (sep && cellLayout) {
      // tableau à séparateurs : chaque cellule suit la colonne d'en-tête correspondante
      rowLayout = cellLayout;
      numbers = cells.map((c) => parseNumber(c.replace(/\b(RH|RB|SUSP\w*)\b/gi, "").trim()));
    } else if (sep) {
      // séparateurs sans en-tête : disposition configurée ou par défaut après symbole et libellé éventuel
      const data = cells.slice(symIdx + 1).filter((c) => isNumToken(c.replace(/\b(RH|RB|SUSP\w*)\b/gi, "").trim()) || c.trim() === "");
      numbers = data.map((c) => parseNumber(c.replace(/\b(RH|RB|SUSP\w*)\b/gi, "").trim()));
    } else {
      const toks = mergeThousands(cells.slice(1).filter((c) => !/^(RH|RB|SUSP\w*)$/i.test(c)));
      const firstNum = toks.findIndex((t) => isNumToken(t));
      if (firstNum < 0) { unrecognized++; continue; }
      numbers = toks.slice(firstNum).filter((t) => isNumToken(t)).map(parseNumber);
    }
    if (!numbers.some((n) => n != null)) { unrecognized++; continue; }
    assign(row, rowLayout, numbers);
    // cohérence : clôture absente mais ouverture présente (titre non traité) ; variation déduite
    if (row.close == null && row.ref != null && row.volume === 0) row.close = row.ref;
    if (row.changePct == null && row.close != null && row.ref) row.changePct = Math.round(((row.close - row.ref) / row.ref) * 10000) / 100;
    if (row.value == null && row.volume != null && row.close != null) row.value = row.volume * row.close;
    rows.push(row);
  }
  return { sessionTs, rows, layout, layoutSource, unrecognized };
}
