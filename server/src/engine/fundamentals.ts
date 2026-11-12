/**
 * Fondamentaux des sociétés cotées : lecture structurée des publications (communiqués de résultats,
 * états financiers) et ratios de valorisation.
 *
 * Les montants sont lus en FCFA (« 1 234,5 milliards de FCFA », « 45 Mds FCFA », « 12 millions »),
 * la période d'après le vocabulaire (exercice 2025, premier semestre 2025, au 30 juin 2025, T3 2025).
 * Rien n'est inventé : un champ absent du texte reste null et la ligne est marquée « auto » tant
 * qu'un analyste ne l'a pas confirmée ou corrigée.
 */

export interface FinancialFigures {
  /** « 2025 », « S1 2025 », « T3 2025 » */
  period: string | null;
  /** fin de période (début de journée UTC) */
  periodEnd: number | null;
  revenue: number | null; // chiffre d'affaires (FCFA)
  netIncome: number | null; // résultat net (FCFA)
  equity: number | null; // capitaux propres (FCFA)
  eps: number | null; // bénéfice par action (FCFA)
  dps: number | null; // dividende par action (FCFA)
  revenueGrowthPct: number | null; // variation annoncée du chiffre d'affaires (%)
  netIncomeGrowthPct: number | null; // variation annoncée du résultat net (%)
}

export interface FinancialRecord extends FinancialFigures {
  id: number;
  symbol: string;
  period: string;
  periodEnd: number;
  publishedAt: number | null;
  shares: number | null;
  source: string;
  url: string | null;
  note: string | null;
  status: "auto" | "analyste";
  updatedAt: number;
}

export interface ValuationMetrics {
  /** période annuelle de référence */
  annualPeriod: string | null;
  latestPeriod: string | null;
  eps: number | null;
  bookValuePerShare: number | null;
  per: number | null;
  priceToBook: number | null;
  /** rendement bénéficiaire (1 / PER) en % */
  earningsYieldPct: number | null;
  roePct: number | null;
  revenueGrowthPct: number | null;
  netIncomeGrowthPct: number | null;
  payoutPct: number | null;
  netMarginPct: number | null;
  /** nombre d'actions utilisé pour les ratios par action */
  shares: number | null;
  /** champs manquants qui empêchent certains ratios */
  missing: string[];
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
const MONTHS: Record<string, number> = { janvier: 0, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11 };

/** Montant en FCFA à partir d'un nombre et de son unité (« milliards », « Mds », « millions », « M »). */
export function parseAmount(numText: string, unit: string | undefined): number | null {
  const n = Number(numText.replace(/[  ]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const u = (unit ?? "").toLowerCase();
  if (/milliard|mds|mrds|md\b|g\b/.test(u)) return n * 1e9;
  if (/million|mio|m\b/.test(u)) return n * 1e6;
  if (/millier|k\b/.test(u)) return n * 1e3;
  return n;
}

const AMOUNT = "(\\d{1,3}(?:[ \\u00a0.]\\d{3})*(?:,\\d+)?|\\d+(?:[.,]\\d+)?)\\s*(milliards?|mds|mrds|millions?|mio|milliers?|m|k)?\\s*(?:de\\s+)?(?:f ?cfa|fcfa|xof|francs?)?";

function amountAfter(text: string, keyword: RegExp): number | null {
  const m = keyword.exec(text);
  if (!m || m.index == null) return null;
  const window = text.slice(m.index + m[0].length, m.index + m[0].length + 110);
  const a = new RegExp(`^[^\\d%]{0,40}?${AMOUNT}`).exec(window);
  if (!a) return null;
  // un pourcentage juste après le nombre n'est pas un montant
  if (/^\s*%/.test(window.slice(a[0].length)) || /^[^\d]{0,40}?\d[\d ,.]*\s*%/.test(window) && !a[2]) return null;
  return parseAmount(a[1], a[2]);
}

function growthAfter(text: string, keyword: RegExp): number | null {
  const m = keyword.exec(text);
  if (!m || m.index == null) return null;
  const window = text.slice(m.index, m.index + 220);
  const g = /(?:en )?(hausse|progression|croissance|augmentation|baisse|recul|repli|diminution|contraction)\s+de\s+(\d+(?:[.,]\d+)?)\s*%/.exec(window) ?? /\(([+-])\s?(\d+(?:[.,]\d+)?)\s*%\)/.exec(window);
  if (!g) return null;
  const v = Number(g[2].replace(",", "."));
  if (!Number.isFinite(v)) return null;
  const neg = /baisse|recul|repli|diminution|contraction/.test(g[1]) || g[1] === "-";
  return neg ? -v : v;
}

/** Période couverte et sa date de fin. */
export function parsePeriod(text: string): { period: string | null; periodEnd: number | null } {
  const t = norm(text);
  const end = (y: number, m: number, d: number) => Date.UTC(y, m, d);
  let m: RegExpExecArray | null;
  if ((m = /(?:premier|1er|1)\s*(?:semestre|s1)|s1\s*(20\d{2})|(?:semestre|au)\s*30 juin\s*(20\d{2})|premier semestre\s*(20\d{2})/.exec(t))) {
    const y = Number(m[1] ?? m[2] ?? m[3] ?? t.match(/\b(20\d{2})\b/)?.[1]);
    if (Number.isFinite(y)) return { period: `S1 ${y}`, periodEnd: end(y, 5, 30) };
  }
  if ((m = /(?:troisieme|3e|3eme|t3)\s*trimestre\s*(20\d{2})?|t3\s*(20\d{2})|au 30 septembre\s*(20\d{2})|neuf premiers mois\s*(?:de\s*)?(20\d{2})/.exec(t))) {
    const y = Number(m[1] ?? m[2] ?? m[3] ?? m[4] ?? t.match(/\b(20\d{2})\b/)?.[1]);
    if (Number.isFinite(y)) return { period: `T3 ${y}`, periodEnd: end(y, 8, 30) };
  }
  if ((m = /(?:premier|1er)\s*trimestre\s*(20\d{2})?|t1\s*(20\d{2})|au 31 mars\s*(20\d{2})/.exec(t))) {
    const y = Number(m[1] ?? m[2] ?? m[3] ?? t.match(/\b(20\d{2})\b/)?.[1]);
    if (Number.isFinite(y)) return { period: `T1 ${y}`, periodEnd: end(y, 2, 31) };
  }
  if ((m = /exercice\s*(?:clos\s*(?:le|au)\s*31 decembre\s*)?(20\d{2})|(?:comptes|resultats?|etats financiers)\s*(?:annuels?|de l'exercice|au 31 decembre)\s*(20\d{2})|au 31 decembre\s*(20\d{2})|annuels?\s*(20\d{2})|\b(20\d{2})\b/.exec(t))) {
    const y = Number(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]);
    if (Number.isFinite(y)) return { period: String(y), periodEnd: end(y, 11, 31) };
  }
  return { period: null, periodEnd: null };
}

/** Date de publication mentionnée (« Abidjan, le 12 mars 2026 », « 12/03/2026 »). */
export function parsePublicationDate(text: string): number | null {
  const t = norm(text);
  const fr = t.match(/(\d{1,2})\/(\d{1,2})\/(20\d{2})/);
  if (fr) return Date.UTC(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]));
  const lit = t.match(/(\d{1,2})(?:er)?\s+([a-z]+)\s+(20\d{2})/);
  if (lit && MONTHS[lit[2]] != null) return Date.UTC(Number(lit[3]), MONTHS[lit[2]], Number(lit[1]));
  return null;
}

/** Lecture d'un communiqué de résultats ou d'états financiers. */
export function parseFinancialNotice(text: string): FinancialFigures {
  const t = norm(text);
  const revenue = amountAfter(t, /chiffre d'affaires(?: consolide| net| global)?(?: de la periode| de l'exercice| du semestre)?(?: s'etablit a| s'eleve a| ressort a| atteint| de| :)?/) ?? amountAfter(t, /produit net bancaire(?: s'etablit a| s'eleve a| ressort a| de| :)?/);
  const netIncome = amountAfter(t, /(?:resultat net|benefice net)(?: part du groupe| consolide)?(?: s'etablit a| s'eleve a| ressort a| atteint| de| :)?/);
  const equity = amountAfter(t, /capitaux propres(?: s'etablissent a| s'elevent a| de| :)?/);
  const eps = amountAfter(t, /(?:benefice|resultat) (?:net )?par action(?: de| :)?/);
  const dps = amountAfter(t, /dividende(?: net| brut)?(?: par action)?(?: de| propose de| :)?/);
  const revenueGrowthPct = growthAfter(t, /chiffre d'affaires|produit net bancaire/);
  const netIncomeGrowthPct = growthAfter(t, /resultat net|benefice net/);
  const { period, periodEnd } = parsePeriod(t);
  return { period, periodEnd, revenue, netIncome, equity, eps, dps, revenueGrowthPct, netIncomeGrowthPct };
}

const isAnnual = (p: string) => /^20\d{2}$/.test(p);

/** Ratios de valorisation à partir des enregistrements d'une société (les plus récents en premier). */
export function valuationMetrics(records: FinancialRecord[], price: number, sharesHint: number | null): ValuationMetrics {
  const sorted = [...records].sort((a, b) => b.periodEnd - a.periodEnd);
  const annual = sorted.filter((r) => isAnnual(r.period));
  const latestAnnual = annual[0] ?? null;
  const prevAnnual = annual[1] ?? null;
  const latest = sorted[0] ?? null;
  const shares = latestAnnual?.shares ?? latest?.shares ?? sharesHint ?? null;
  const missing: string[] = [];
  const eps = latestAnnual?.eps ?? (latestAnnual?.netIncome != null && shares ? latestAnnual.netIncome / shares : null);
  if (eps == null) missing.push(latestAnnual ? "nombre d'actions ou bénéfice par action" : "résultat annuel");
  const bvps = latestAnnual?.equity != null && shares ? latestAnnual.equity / shares : null;
  if (bvps == null && latestAnnual?.equity == null) missing.push("capitaux propres");
  const per = eps != null && eps > 0 && price > 0 ? price / eps : null;
  const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
  const growth = (cur: number | null | undefined, prev: number | null | undefined, announced: number | null | undefined) => (cur != null && prev != null && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : (announced ?? null));
  return {
    annualPeriod: latestAnnual?.period ?? null,
    latestPeriod: latest?.period ?? null,
    eps: r1(eps),
    bookValuePerShare: r1(bvps),
    per: r1(per),
    priceToBook: bvps != null && bvps > 0 && price > 0 ? r1(price / bvps) : null,
    earningsYieldPct: eps != null && price > 0 ? r1((eps / price) * 100) : null,
    roePct: latestAnnual?.netIncome != null && latestAnnual.equity ? r1((latestAnnual.netIncome / latestAnnual.equity) * 100) : null,
    revenueGrowthPct: r1(growth(latestAnnual?.revenue, prevAnnual?.revenue, latestAnnual?.revenueGrowthPct)),
    netIncomeGrowthPct: r1(growth(latestAnnual?.netIncome, prevAnnual?.netIncome, latestAnnual?.netIncomeGrowthPct)),
    payoutPct: latestAnnual?.dps != null && eps ? r1((latestAnnual.dps / eps) * 100) : null,
    netMarginPct: latestAnnual?.netIncome != null && latestAnnual.revenue ? r1((latestAnnual.netIncome / latestAnnual.revenue) * 100) : null,
    shares,
    missing,
  };
}
