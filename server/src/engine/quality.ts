/**
 * Score de qualité et de risque d'un titre coté à la BRVM : 0 à 100, règles publiées.
 *
 * Cinq parties, chacune notée linéairement entre un seuil « plein » et un seuil « nul » ; des
 * drapeaux rouges forcent le verdict RISQUÉ quel que soit le score ; des plafonds limitent le
 * verdict à FRAGILE. Une donnée absente n'est jamais comptée comme bonne : la partie est marquée
 * « non vérifiée », retirée du dénominateur, et la confiance du score baisse d'autant.
 * Les règles sont exposées telles quelles par `QUALITY_RULES` (et documentées dans docs/REGLES_SCORE.md).
 */

export type QualityBand = "SOLIDE" | "CORRECT" | "FRAGILE" | "RISQUÉ";

export interface CompanyProfile {
  freeFloatPct: number | null; // flottant (% du capital)
  mainHolderPct: number | null; // part de l'actionnaire principal (% du capital)
  mainHolderName: string | null;
  statePct: number | null;
  sharesOutstanding: number | null;
  payoutRatioPct: number | null; // dividende / résultat net (%)
  dividendYears: number | null; // années consécutives de dividende versé
  suspended: boolean;
  suspendedReason: string | null;
}

export interface QualityInput {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  /** capitaux moyens échangés par séance sur 60 séances (FCFA) */
  avgValueTraded60: number;
  /** séances sans aucun échange sur les 20 dernières */
  zeroVolumeDays20: number;
  volatility60: number; // décimal annualisé
  maxDrawdown250: number; // décimal négatif
  dividendYield: number; // %
  sectorMedianYield: number; // %
  profile: CompanyProfile;
  publications: { lastAnnualReportYear: number | null; lastResultsDate: number | null; lastResultsPeriod: string | null; documents: number };
  news: { score: number; count: number; suspensionMentioned: boolean };
  today?: number;
}

export interface QualityPart {
  key: "liquidite" | "stabilite" | "transparence" | "actionnariat" | "rendement";
  label: string;
  points: number; // obtenus
  max: number;
  verified: boolean;
  value: string; // mesure lisible
  text: string; // explication
}

export interface QualityFlag {
  hard: boolean; // drapeau rouge (RISQUÉ) ou plafond (FRAGILE au mieux)
  text: string;
}

export interface QualityResult {
  symbol: string;
  score: number;
  band: QualityBand;
  confidence: number; // part du barème vérifiée, 0..1
  parts: QualityPart[];
  flags: QualityFlag[];
  unverified: string[];
  headline: string;
  rulesVersion: string;
  computedAt: number;
}

export const QUALITY_RULES = {
  version: "1.0",
  bands: { SOLIDE: 80, CORRECT: 60, FRAGILE: 40 },
  positionFcfa: 10_000_000, // position de référence pour la liquidité
  participation: 0.2, // part des volumes quotidiens qu'un vendeur peut absorber sans peser sur le cours
  parts: {
    liquidite: { max: 25, label: "Liquidité", full: "≤ 5 séances pour céder 10 M FCFA", zero: "≥ 60 séances", fullAt: 5, zeroAt: 60 },
    stabilite: { max: 20, label: "Stabilité des cours", full: "volatilité ≤ 20 % et repli max ≤ 15 %", zero: "volatilité ≥ 60 % ou repli max ≥ 50 %", vol: [0.2, 0.6], drawdown: [0.15, 0.5] },
    transparence: { max: 20, label: "Transparence", full: "rapport annuel du dernier exercice publié et résultats de moins de 7 mois", zero: "aucun rapport annuel depuis deux exercices ou résultats de plus de 13 mois", resultsMonths: [7, 13] },
    actionnariat: { max: 20, label: "Structure de l'actionnariat", full: "flottant ≥ 30 % et actionnaire principal ≤ 50 %", zero: "flottant ≤ 10 % ou actionnaire principal ≥ 85 %", freeFloat: [30, 10], mainHolder: [50, 85] },
    rendement: { max: 15, label: "Rendement et dividende", full: "rendement ≥ max(4 %, médiane du secteur) et 5 ans de dividendes", zero: "aucun dividende", minFull: 4, yearsFull: 5 },
  },
  redFlags: [
    "cotation suspendue (profil ou actualité des 30 derniers jours)",
    "rapport annuel de l'exercice précédent toujours absent au 31 octobre",
    "flottant inférieur à 10 %",
    "aucun échange sur les 20 dernières séances",
  ],
  caps: [
    "plus de 30 séances pour céder 10 M FCFA",
    "10 séances ou plus sans échange sur 20",
    "actionnaire principal à 85 % ou plus",
    "taux de distribution supérieur à 100 %",
    "actualité fortement défavorable (sentiment ≤ −0,5 sur au moins 3 articles)",
    "profil vérifié à moins de 60 % du barème",
  ],
} as const;

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Note linéaire : 1 au seuil « plein », 0 au seuil « nul », quel que soit leur ordre. */
export function linear(x: number, full: number, zero: number): number {
  if (full === zero) return x <= full ? 1 : 0;
  const t = (x - zero) / (full - zero);
  return Math.max(0, Math.min(1, t));
}

export function assessQuality(i: QualityInput): QualityResult {
  const R = QUALITY_RULES;
  const today = i.today ?? Date.now();
  const parts: QualityPart[] = [];
  const flags: QualityFlag[] = [];
  const unverified: string[] = [];

  // 1. Liquidité
  const daily = i.avgValueTraded60 * R.participation;
  const days = daily > 0 ? R.positionFcfa / daily : Infinity;
  const liq = Number.isFinite(days) ? linear(days, R.parts.liquidite.fullAt, R.parts.liquidite.zeroAt) : 0;
  parts.push({ key: "liquidite", label: R.parts.liquidite.label, points: r1(liq * R.parts.liquidite.max), max: R.parts.liquidite.max, verified: true, value: Number.isFinite(days) ? `${Math.ceil(days)} séance(s) pour 10 M FCFA` : "aucun échange", text: `Capitaux moyens ${Math.round(i.avgValueTraded60).toLocaleString("fr-FR")} FCFA par séance sur 60 séances ; en absorbant 20 % des volumes, céder 10 M FCFA prend ${Number.isFinite(days) ? Math.ceil(days) : "une durée indéterminée"} séance(s)${i.zeroVolumeDays20 ? ` ; ${i.zeroVolumeDays20} séance(s) sans échange sur 20` : ""}.` });
  if (Number.isFinite(days) && days >= 30) flags.push({ hard: false, text: `Liquidité faible : ${Math.ceil(days)} séances pour céder 10 M FCFA` });
  if (i.zeroVolumeDays20 >= 20) flags.push({ hard: true, text: "Aucun échange sur les 20 dernières séances" });
  else if (i.zeroVolumeDays20 >= 10) flags.push({ hard: false, text: `${i.zeroVolumeDays20} séances sans échange sur les 20 dernières` });

  // 2. Stabilité
  const sv = linear(i.volatility60, R.parts.stabilite.vol[0], R.parts.stabilite.vol[1]);
  const sd = linear(Math.abs(i.maxDrawdown250), R.parts.stabilite.drawdown[0], R.parts.stabilite.drawdown[1]);
  const stab = (sv + sd) / 2;
  parts.push({ key: "stabilite", label: R.parts.stabilite.label, points: r1(stab * R.parts.stabilite.max), max: R.parts.stabilite.max, verified: true, value: `volatilité ${Math.round(i.volatility60 * 100)} %, repli max ${Math.round(i.maxDrawdown250 * 100)} %`, text: `Volatilité annualisée sur 60 séances ${Math.round(i.volatility60 * 100)} % et perte maximale sur un an ${Math.round(i.maxDrawdown250 * 100)} %.` });

  // 3. Transparence (publications)
  const year = new Date(today).getUTCFullYear();
  const afterApril = new Date(today).getUTCMonth() >= 4; // mai et au-delà
  const afterOctober = new Date(today).getUTCMonth() >= 10; // novembre et au-delà
  const lastRA = i.publications.lastAnnualReportYear;
  const expectedRA = afterApril ? year - 1 : year - 2;
  if (lastRA == null && i.publications.lastResultsDate == null) {
    parts.push({ key: "transparence", label: R.parts.transparence.label, points: 0, max: R.parts.transparence.max, verified: false, value: "aucune publication collectée", text: "Aucun rapport annuel ni résultats n'a été collecté pour cette société : la transparence n'a pas pu être vérifiée." });
    unverified.push("transparence");
  } else {
    const raScore = lastRA == null ? 0.5 : lastRA >= expectedRA ? 1 : lastRA === expectedRA - 1 ? 0.4 : 0;
    const monthsSince = i.publications.lastResultsDate ? (today - i.publications.lastResultsDate) / (30.44 * 86_400_000) : null;
    const resScore = monthsSince == null ? 0.5 : linear(monthsSince, R.parts.transparence.resultsMonths[0], R.parts.transparence.resultsMonths[1]);
    const tr = (raScore + resScore) / 2;
    parts.push({ key: "transparence", label: R.parts.transparence.label, points: r1(tr * R.parts.transparence.max), max: R.parts.transparence.max, verified: true, value: `${lastRA != null ? `rapport annuel ${lastRA}` : "rapport annuel non collecté"}, ${monthsSince != null ? `résultats il y a ${Math.round(monthsSince)} mois` : "résultats non collectés"}`, text: `Dernier rapport annuel collecté : ${lastRA ?? "aucun"} (attendu : exercice ${expectedRA}) ; derniers résultats : ${i.publications.lastResultsPeriod ?? "aucun"}${monthsSince != null ? ` publiés il y a ${Math.round(monthsSince)} mois` : ""}.` });
    if (afterOctober && lastRA != null && lastRA < year - 1) flags.push({ hard: true, text: `Rapport annuel de l'exercice ${year - 1} toujours absent après le 31 octobre` });
  }

  // 4. Actionnariat
  const ff = i.profile.freeFloatPct;
  const mh = i.profile.mainHolderPct;
  if (ff == null && mh == null) {
    parts.push({ key: "actionnariat", label: R.parts.actionnariat.label, points: 0, max: R.parts.actionnariat.max, verified: false, value: "non renseigné", text: "Flottant et actionnaire principal non renseignés : la structure de l'actionnariat n'a pas pu être vérifiée (un analyste peut la saisir)." });
    unverified.push("actionnariat");
  } else {
    const sff = ff != null ? linear(ff, R.parts.actionnariat.freeFloat[0], R.parts.actionnariat.freeFloat[1]) : null;
    const smh = mh != null ? linear(mh, R.parts.actionnariat.mainHolder[0], R.parts.actionnariat.mainHolder[1]) : null;
    const vals = [sff, smh].filter((x): x is number => x != null);
    const act = vals.reduce((a, b) => a + b, 0) / vals.length;
    parts.push({ key: "actionnariat", label: R.parts.actionnariat.label, points: r1(act * R.parts.actionnariat.max), max: R.parts.actionnariat.max, verified: true, value: `${ff != null ? `flottant ${ff} %` : "flottant inconnu"}, ${mh != null ? `principal ${mh} %` : "principal inconnu"}`, text: `${ff != null ? `Flottant ${ff} % du capital` : "Flottant non renseigné"} ; ${mh != null ? `actionnaire principal${i.profile.mainHolderName ? ` (${i.profile.mainHolderName})` : ""} à ${mh} %` : "actionnaire principal non renseigné"}${i.profile.statePct != null ? ` ; État ${i.profile.statePct} %` : ""}.` });
    if (ff != null && ff < 10) flags.push({ hard: true, text: `Flottant de ${ff} % : titre quasi illiquide par construction` });
    if (mh != null && mh >= 85) flags.push({ hard: false, text: `Actionnaire principal à ${mh} % : les minoritaires n'ont aucun poids` });
  }

  // 5. Rendement
  const target = Math.max(R.parts.rendement.minFull, i.sectorMedianYield);
  const yScore = i.dividendYield <= 0 ? 0 : Math.min(1, i.dividendYield / target);
  const yearsScore = i.profile.dividendYears == null ? null : Math.min(1, i.profile.dividendYears / R.parts.rendement.yearsFull);
  const rend = yearsScore == null ? yScore : 0.7 * yScore + 0.3 * yearsScore;
  parts.push({ key: "rendement", label: R.parts.rendement.label, points: r1(rend * R.parts.rendement.max), max: R.parts.rendement.max, verified: true, value: `${i.dividendYield.toFixed(1)} % (secteur ${i.sectorMedianYield.toFixed(1)} %)${i.profile.dividendYears != null ? `, ${i.profile.dividendYears} an(s) de dividendes` : ""}`, text: `Rendement du dividende ${i.dividendYield.toFixed(1)} % contre ${i.sectorMedianYield.toFixed(1)} % de médiane sectorielle${i.profile.dividendYears != null ? ` ; ${i.profile.dividendYears} année(s) consécutive(s) de dividende` : " ; régularité non renseignée"}${i.profile.payoutRatioPct != null ? ` ; taux de distribution ${i.profile.payoutRatioPct} %` : ""}.` });
  if (i.profile.payoutRatioPct != null && i.profile.payoutRatioPct > 100) flags.push({ hard: false, text: `Taux de distribution ${i.profile.payoutRatioPct} % : le dividende dépasse le résultat` });

  // Suspension et actualité
  if (i.profile.suspended) flags.push({ hard: true, text: `Cotation suspendue${i.profile.suspendedReason ? ` : ${i.profile.suspendedReason}` : ""}` });
  else if (i.news.suspensionMentioned) flags.push({ hard: true, text: "Une suspension de cotation est mentionnée dans l'actualité des 30 derniers jours" });
  if (i.news.count >= 3 && i.news.score <= -0.5) flags.push({ hard: false, text: `Actualité fortement défavorable (sentiment ${i.news.score} sur ${i.news.count} articles)` });

  // Agrégation : parties vérifiées seulement, confiance = part du barème vérifiée
  const verified = parts.filter((p) => p.verified);
  const maxVerified = verified.reduce((a, p) => a + p.max, 0);
  const confidence = maxVerified / 100;
  let score = maxVerified ? Math.round((verified.reduce((a, p) => a + p.points, 0) / maxVerified) * 100) : 0;
  if (confidence < 0.6) flags.push({ hard: false, text: `Profil vérifié à ${Math.round(confidence * 100)} % du barème seulement` });
  const hard = flags.some((f) => f.hard);
  const soft = flags.some((f) => !f.hard);
  if (soft) score = Math.min(score, 59);
  const band: QualityBand = hard ? "RISQUÉ" : score >= R.bands.SOLIDE ? "SOLIDE" : score >= R.bands.CORRECT ? "CORRECT" : score >= R.bands.FRAGILE ? "FRAGILE" : "RISQUÉ";
  const best = [...verified].sort((a, b) => b.points / b.max - a.points / a.max)[0];
  const worst = [...verified].sort((a, b) => a.points / a.max - b.points / b.max)[0];
  const headline = hard
    ? `${band} : ${flags.find((f) => f.hard)!.text.toLowerCase()}`
    : `${band} ${score}/100 · point fort : ${best?.label.toLowerCase() ?? "—"} · point faible : ${worst?.label.toLowerCase() ?? "—"}${unverified.length ? ` · non vérifié : ${unverified.join(", ")}` : ""}`;

  return { symbol: i.symbol, score, band, confidence: Math.round(confidence * 100) / 100, parts, flags, unverified, headline, rulesVersion: R.version, computedAt: today };
}
