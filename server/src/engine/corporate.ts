/**
 * Actions sur le capital et historique ajusté.
 *
 * Sur la BRVM, plusieurs sociétés ont divisé leur nominal (fractionnement) et les dividendes
 * représentent 5 à 10 % du cours : une série de clôtures brute montre donc des « chutes » qui ne
 * sont pas des pertes. Les modèles (prévision, optimisation, indicateurs) doivent apprendre sur
 * une série ajustée, où chaque clôture antérieure à une opération est ramenée dans l'unité de
 * la clôture actuelle :
 *  - fractionnement 1 → k (k actions nouvelles pour une ancienne) : cours ÷ k, volumes × k ;
 *  - regroupement k → 1 : cours × k, volumes ÷ k ;
 *  - détachement d'un dividende D : cours × (1 − D / C), C étant la clôture de la veille du
 *    détachement (ajustement « rendement total », méthode CRSP) ;
 *  - attribution gratuite 1 nouvelle pour k anciennes : cours × k / (k + 1), volumes × (k + 1) / k.
 * Les facteurs se cumulent en remontant le temps ; les bougies à partir de la date de l'opération
 * ne changent pas, le dernier cours ajusté est donc toujours le cours réel.
 */
import type { Candle } from "./indicators.js";

export type CorporateKind = "split" | "reverse_split" | "dividend" | "bonus";

export interface CorporateAction {
  symbol: string;
  kind: CorporateKind;
  /** date d'effet (détachement), début de journée UTC en ms */
  exDate: number;
  /** fractionnement : actions nouvelles par action ancienne ; regroupement : anciennes par nouvelle ; attribution : anciennes pour une gratuite */
  ratio?: number | null;
  /** dividende net par action (FCFA) */
  amount?: number | null;
}

export interface AdjustmentStep {
  exDate: number;
  kind: CorporateKind;
  /** facteur appliqué aux cours antérieurs à exDate */
  priceFactor: number;
  volumeFactor: number;
  detail: string;
}

export interface AdjustedSeries {
  candles: Candle[];
  steps: AdjustmentStep[];
  /** facteur cumulé appliqué à la bougie la plus ancienne (1 = aucun ajustement) */
  totalFactor: number;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Facteur d'une opération à partir de la clôture de la veille (null si l'opération est ignorée). */
export function actionFactor(a: CorporateAction, closeBefore: number | null): { price: number; volume: number; detail: string } | null {
  if (a.kind === "split") {
    const k = a.ratio ?? 0;
    if (!(k > 1)) return null;
    return { price: 1 / k, volume: k, detail: `fractionnement 1 → ${k}` };
  }
  if (a.kind === "reverse_split") {
    const k = a.ratio ?? 0;
    if (!(k > 1)) return null;
    return { price: k, volume: 1 / k, detail: `regroupement ${k} → 1` };
  }
  if (a.kind === "bonus") {
    const k = a.ratio ?? 0;
    if (!(k > 0)) return null;
    return { price: k / (k + 1), volume: (k + 1) / k, detail: `attribution gratuite 1 pour ${k}` };
  }
  const d = a.amount ?? 0;
  if (!(d > 0) || closeBefore == null || !(closeBefore > d)) return null;
  return { price: 1 - d / closeBefore, volume: 1, detail: `dividende ${d} FCFA (${((d / closeBefore) * 100).toFixed(2)} % du cours de ${closeBefore})` };
}

/**
 * Série ajustée des opérations postérieures à la première bougie. Les bougies sont supposées
 * triées par date croissante ; la série rendue est une copie, l'originale n'est pas modifiée.
 */
export function adjustCandles(candles: Candle[], actions: CorporateAction[]): AdjustedSeries {
  if (!candles.length) return { candles: [], steps: [], totalFactor: 1 };
  const firstTs = candles[0].ts;
  const lastTs = candles[candles.length - 1].ts;
  const relevant = actions.filter((a) => a.exDate > firstTs && a.exDate <= lastTs + 86_400_000).sort((a, b) => b.exDate - a.exDate);
  if (!relevant.length) return { candles: candles.map((c) => ({ ...c })), steps: [], totalFactor: 1 };
  const out = candles.map((c) => ({ ...c }));
  const steps: AdjustmentStep[] = [];
  let priceCum = 1;
  let volCum = 1;
  // on parcourt de la plus récente à la plus ancienne : chaque opération ajuste tout ce qui la précède
  let i = out.length - 1;
  for (const a of relevant) {
    while (i >= 0 && out[i].ts >= a.exDate) {
      out[i].open *= priceCum; out[i].high *= priceCum; out[i].low *= priceCum; out[i].close *= priceCum;
      out[i].volume = Math.round(out[i].volume * volCum);
      i--;
    }
    // clôture brute de la veille du détachement (la bougie i est la dernière strictement avant exDate)
    const closeBefore = i >= 0 ? candles[i].close : null;
    const f = actionFactor(a, closeBefore);
    if (!f) continue;
    priceCum *= f.price;
    volCum *= f.volume;
    steps.push({ exDate: a.exDate, kind: a.kind, priceFactor: round4(f.price), volumeFactor: round4(f.volume), detail: f.detail });
  }
  while (i >= 0) {
    out[i].open *= priceCum; out[i].high *= priceCum; out[i].low *= priceCum; out[i].close *= priceCum;
    out[i].volume = Math.round(out[i].volume * volCum);
    i--;
  }
  return { candles: out, steps, totalFactor: round4(priceCum) };
}

export interface SuspectedSplit {
  symbol: string;
  exDate: number;
  kind: "split" | "reverse_split";
  ratio: number;
  closeBefore: number;
  closeAfter: number;
  /** écart relatif entre le rapport observé et le rapport entier retenu */
  deviation: number;
}

/**
 * Détection des fractionnements probables : la BRVM réserve un titre dès ±7,5 % en séance, un
 * rapport de clôtures proche de 1/k (ou k) avec k entier ≥ 2, confirmé par les séances suivantes,
 * ne peut donc venir que d'une opération sur le capital. Les cas détectés sont « suspectés » :
 * un analyste les confirme (ou les rejette) avant qu'ils n'ajustent les séries.
 */
export function detectSplits(symbol: string, candles: Candle[], opts: { minRatio?: number; maxRatio?: number; tolerance?: number; confirmSessions?: number } = {}): SuspectedSplit[] {
  const minRatio = opts.minRatio ?? 2;
  const maxRatio = opts.maxRatio ?? 100;
  const tol = opts.tolerance ?? 0.08;
  const confirm = opts.confirmSessions ?? 3;
  const out: SuspectedSplit[] = [];
  for (let t = 1; t < candles.length; t++) {
    const before = candles[t - 1].close;
    const after = candles[t].close;
    if (!(before > 0) || !(after > 0)) continue;
    const r = before / after;
    const candidates: { kind: "split" | "reverse_split"; ratio: number; observed: number }[] = [];
    if (r >= minRatio * (1 - tol)) candidates.push({ kind: "split", ratio: Math.round(r), observed: r });
    if (1 / r >= minRatio * (1 - tol)) candidates.push({ kind: "reverse_split", ratio: Math.round(1 / r), observed: 1 / r });
    for (const c of candidates) {
      if (c.ratio < minRatio || c.ratio > maxRatio) continue;
      const deviation = Math.abs(c.observed / c.ratio - 1);
      if (deviation > tol) continue;
      // confirmation : les séances suivantes restent dans la nouvelle unité
      const next = candles.slice(t + 1, t + 1 + confirm).map((x) => x.close);
      const ok = next.every((x) => {
        const rr = c.kind === "split" ? before / x : x / before;
        return Math.abs(rr / c.ratio - 1) <= 0.25;
      });
      if (!ok) continue;
      out.push({ symbol, exDate: candles[t].ts, kind: c.kind, ratio: c.ratio, closeBefore: before, closeAfter: after, deviation: round4(deviation) });
    }
  }
  return out;
}

export interface DividendNotice {
  gross: number | null;
  net: number | null;
  fiscalYear: number | null;
  exDate: number | null;
  paymentDate: number | null;
  agmDate: number | null;
  status: "proposé" | "approuvé" | "payé" | null;
}

const MONTHS: Record<string, number> = { janvier: 0, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11, jan: 0, fev: 1, mar: 2, avr: 3, jun: 5, jul: 6, juil: 6, aou: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");

function dateNear(text: string, keyword: RegExp): number | null {
  const m = text.match(keyword);
  if (!m || m.index == null) return null;
  const window = text.slice(m.index, m.index + 90);
  // première date rencontrée après le mot-clé, qu'elle soit numérique ou littérale
  const fr = window.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
  const lit = window.match(/(\d{1,2})(?:er)?\s+([a-z]+)\.?\s+(\d{4})/);
  const litOk = lit && MONTHS[lit[2]] != null ? lit : null;
  if (fr && (!litOk || fr.index! <= litOk.index!)) return Date.UTC(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]));
  if (litOk) return Date.UTC(Number(litOk[3]), MONTHS[litOk[2]], Number(litOk[1]));
  return null;
}

function amountNear(text: string, keyword: RegExp): number | null {
  const m = text.match(keyword);
  if (!m || m.index == null) return null;
  const window = text.slice(m.index, m.index + 120);
  const a = window.match(/(\d{1,3}(?:[  .]\d{3})*(?:,\d+)?|\d+(?:[.,]\d+)?)\s*(?:f ?cfa|fcfa|xof|francs?)/);
  if (!a) return null;
  const n = Number(a[1].replace(/[  ]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Lecture d'un avis de dividende (titre et résumé d'actualité, titre de document) : montants brut
 * et net, exercice, dates de détachement, de paiement et d'assemblée, statut d'après le vocabulaire.
 * Rien n'est inventé : chaque champ absent du texte reste null.
 */
export function parseDividendNotice(text: string): DividendNotice {
  const t = norm(text);
  const gross = amountNear(t, /dividende brut|brut(?: par action)?/) ?? amountNear(t, /dividende(?: global| total)? (?:de|d'un montant de|par action de|:)/);
  const net = amountNear(t, /dividende net|net(?: par action| d'impot| d'irvm)?/);
  const fy = t.match(/exercice (?:clos (?:le|au) [^,.]*?)?(20\d{2})/) ?? t.match(/(?:dividende|au titre de l'exercice|exercice)\s*(20\d{2})/) ?? t.match(/\b(20\d{2})\b/);
  const exDate = dateNear(t, /detachement|date ex[- ]dividende|ex[- ]date/);
  const paymentDate = dateNear(t, /mise en paiement|paiement|versement/);
  const agmDate = dateNear(t, /assemblee generale|ag[oe]?\b/);
  const status: DividendNotice["status"] = /mise en paiement|paye|verse/.test(t) ? "payé" : /approuv|adopt|vote|decide/.test(t) ? "approuvé" : /propos|projet|recommand|conseil d'administration/.test(t) ? "proposé" : null;
  return { gross: gross ?? (net == null ? amountNear(t, /dividende/) : null), net, fiscalYear: fy ? Number(fy[1]) : null, exDate, paymentDate, agmDate, status };
}
