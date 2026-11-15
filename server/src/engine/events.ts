/**
 * Signaux événementiels pour le moteur court terme.
 *
 * Quatre familles, chacune calculée à une date sans rien lire au-delà (point-in-time), pour nourrir
 * le modèle de panel (où leur poids est appris sur toute la cote) et être mesurées séparément par
 * l'évaluation en marche avant (corrélation de rang avec le rendement réalisé) :
 *
 *  - dérive post-publication : après un résultat ou un dividende en hausse (ou en baisse), un marché
 *    lent continue d'ajuster le cours pendant des semaines ; le signal est la surprise de la dernière
 *    publication connue, amortie linéairement sur 60 jours ;
 *  - fenêtre de dividende : hausse moyenne entre l'annonce et le détachement, repli juste après ;
 *    le signal monte de 0 à 1 dans les 30 jours avant le détachement et vaut −1 → 0 dans les 10
 *    jours qui le suivent ;
 *  - pression du carnet officiel : déséquilibre moyen entre meilleures limites à l'achat et à la
 *    vente sur les 5 dernières séances connues, plus le solde des réservations (hausse − baisse) ;
 *  - momentum résiduel : rendement des 12 derniers mois hors dernier mois, nettoyé de l'exposition
 *    au marché (bêta estimé sur la même fenêtre) et rapporté à sa volatilité résiduelle (score z).
 */

export interface Publication {
  /** date à laquelle la publication est connue (ms UTC) */
  ts: number;
  /** surprise normalisée [−1, 1] : > 0 bonne nouvelle (résultat ou dividende en hausse) */
  surprise: number;
}

export interface DividendDate {
  exDate: number;
}

export interface BookSession {
  ts: number;
  imbalance: number | null;
  reserved: "up" | "down" | null;
}

export const EVENT_SIGNALS: { key: "pubDrift" | "divWindow" | "book5" | "resMom"; label: string; fmt: (v: number) => string }[] = [
  { key: "pubDrift", label: "Dérive post-publication", fmt: (v) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)} %` },
  { key: "divWindow", label: "Fenêtre de dividende", fmt: (v) => (v > 0 ? `détachement proche (${(v * 100).toFixed(0)} %)` : v < 0 ? "juste détaché" : "hors fenêtre") },
  { key: "book5", label: "Pression du carnet officiel (5 séances)", fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}` },
  { key: "resMom", label: "Momentum résiduel 12 mois (hors marché)", fmt: (v) => `z = ${v > 0 ? "+" : ""}${v.toFixed(2)}` },
];

export type EventSignalKey = (typeof EVENT_SIGNALS)[number]["key"];

const DAY = 86_400_000;
const clip = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Surprise d'une publication à partir des croissances connues : résultat net (poids 0,6) et dividende
 * par action (poids 0,4), chacune saturant à ±40 %. Null si aucune des deux n'est connue.
 */
export function surpriseFrom(netIncomeGrowthPct: number | null, dpsChangePct: number | null): number | null {
  if (netIncomeGrowthPct == null && dpsChangePct == null) return null;
  const g = netIncomeGrowthPct != null ? clip(netIncomeGrowthPct / 40, -1, 1) : null;
  const d = dpsChangePct != null ? clip(dpsChangePct / 40, -1, 1) : null;
  if (g != null && d != null) return clip(0.6 * g + 0.4 * d, -1, 1);
  return g ?? d!;
}

/** Dérive post-publication à une date : surprise de la dernière publication connue, amortie sur `windowDays`. */
export function postPublicationDrift(pubs: Publication[], ts: number, windowDays = 60): number {
  let best: Publication | null = null;
  for (const p of pubs) if (p.ts <= ts && (!best || p.ts > best.ts)) best = p;
  if (!best) return 0;
  const days = (ts - best.ts) / DAY;
  if (days > windowDays) return 0;
  return clip(best.surprise, -1, 1) * (1 - days / windowDays);
}

/**
 * Fenêtre de dividende à une date : 0 → 1 dans les `before` jours précédant un détachement
 * (1 la veille), −1 → 0 dans les `after` jours qui le suivent, 0 sinon. Une date de détachement est
 * considérée connue dès 45 jours avant (délai habituel entre l'annonce et le détachement sur la BRVM).
 */
export function dividendWindow(divs: DividendDate[], ts: number, before = 30, after = 10): number {
  let v = 0;
  for (const d of divs) {
    const days = (d.exDate - ts) / DAY;
    if (days > 0 && days <= before) v = Math.max(v, 1 - days / before);
    else if (days <= 0 && -days < after) v = Math.min(v, -(1 + days / after));
  }
  return v;
}

/**
 * Pression du carnet officiel : déséquilibre moyen [−1, 1] des 5 dernières séances connues (dans les
 * 10 jours précédant la date) + 0,2 × solde des réservations ; borné à ±1,5. 0 sans bulletin.
 */
export function bookPressure(sessions: BookSession[], ts: number, n = 5): number {
  const recent = sessions.filter((s) => s.ts <= ts && s.ts >= ts - 10 * DAY).sort((a, b) => b.ts - a.ts).slice(0, n);
  if (!recent.length) return 0;
  const imbs = recent.map((s) => s.imbalance).filter((v): v is number => v != null);
  const imb = imbs.length ? imbs.reduce((a, b) => a + b, 0) / imbs.length : 0;
  const res = recent.reduce((a, s) => a + (s.reserved === "up" ? 1 : s.reserved === "down" ? -1 : 0), 0);
  return clip(imb + 0.2 * res, -1.5, 1.5);
}

/**
 * Momentum résiduel 12 − 1 à l'indice `t` : rendements quotidiens de la valeur régressés sur ceux du
 * marché sur [t − long, t − skip], somme des résidus rapportée à leur écart-type × √n (score z borné à
 * ±3). 0 si l'historique ou le marché manque.
 */
export function residualMomentum(closes: number[], market: (number | null)[] | null, t: number, long = 252, skip = 21): number {
  const start = t - long;
  const end = t - skip;
  if (start < 1 || end <= start + 40) return 0;
  const ri: number[] = [];
  const rm: number[] = [];
  for (let i = start + 1; i <= end; i++) {
    const c0 = closes[i - 1];
    const c1 = closes[i];
    if (!(c0 > 0) || !(c1 > 0)) continue;
    const m0 = market?.[i - 1];
    const m1 = market?.[i];
    ri.push(Math.log(c1 / c0));
    rm.push(m0 != null && m1 != null && m0 > 0 && m1 > 0 ? Math.log(m1 / m0) : 0);
  }
  const n = ri.length;
  if (n < 40) return 0;
  const mi = ri.reduce((a, b) => a + b, 0) / n;
  const mm = rm.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varM = 0;
  for (let k = 0; k < n; k++) { cov += (ri[k] - mi) * (rm[k] - mm); varM += (rm[k] - mm) ** 2; }
  const beta = varM > 1e-12 ? cov / varM : 0;
  const resid = ri.map((r, k) => r - beta * rm[k]);
  const sum = resid.reduce((a, b) => a + b, 0);
  const mr = sum / n;
  const sd = Math.sqrt(resid.reduce((a, r) => a + (r - mr) ** 2, 0) / Math.max(1, n - 1));
  if (!(sd > 1e-9)) return 0;
  return clip(sum / (sd * Math.sqrt(n)), -3, 3);
}

/** Niveau d'un marché équipondéré (base 100) le long d'une chronologie, à partir des clôtures par valeur alignées sur cette chronologie. */
export function equalWeightMarket(timeline: number[], closesByTs: Map<number, number>[]): number[] {
  const out: number[] = [100];
  for (let i = 1; i < timeline.length; i++) {
    const rs: number[] = [];
    for (const m of closesByTs) {
      const a = m.get(timeline[i - 1]);
      const b = m.get(timeline[i]);
      if (a != null && b != null && a > 0 && b > 0) rs.push(Math.log(b / a));
    }
    const r = rs.length ? rs.reduce((x, y) => x + y, 0) / rs.length : 0;
    out.push(out[i - 1] * Math.exp(r));
  }
  return out;
}
