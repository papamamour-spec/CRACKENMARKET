/**
 * Coûts de transaction, fiscalité des dividendes et liquidité.
 *
 * Grille de frais indicative d'un ordre sur la BRVM : commission de la SGI, redevance BRVM, frais du
 * DC/BR, TVA sur les commissions. Les taux réels dépendent de la SGI et du pays : FEES_JSON les
 * surcharge ({ "brokeragePct", "brvmPct", "dcbrPct", "vatPct", "minFee" }).
 *
 * Retenue à la source sur les dividendes (IRVM) par pays de l'émetteur, taux indicatifs des sociétés
 * cotées (DIVIDEND_TAX_JSON surcharge, ex. { "CI": 10, "SN": 10 }). Les rendements lus dans le bulletin
 * officiel sont déjà nets : la table sert aux dividendes saisis en brut et à l'information du rapport.
 *
 * Liquidité : une ligne doit pouvoir être soldée en `exitDays` séances sans dépasser `participation`
 * des capitaux échangés chaque jour ; d'où un plafond de poids par valeur fonction du capital placé.
 */

export interface FeeSchedule {
  /** commission de la SGI, % du montant */
  brokeragePct: number;
  /** redevance BRVM, % */
  brvmPct: number;
  /** frais du dépositaire central, % */
  dcbrPct: number;
  /** TVA appliquée aux commissions (SGI), % */
  vatPct: number;
  /** minimum de perception par ordre, FCFA */
  minFee: number;
}

export const DEFAULT_FEES: FeeSchedule = { brokeragePct: 0.8, brvmPct: 0.1, dcbrPct: 0.05, vatPct: 18, minFee: 2500 };

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return { ...fallback, ...(JSON.parse(raw) as Partial<T>) }; } catch { return fallback; }
}

export function feeSchedule(): FeeSchedule {
  return parseJson(process.env.FEES_JSON, DEFAULT_FEES);
}

/** Coût d'un ordre (un sens) en FCFA. */
export function tradeCost(amount: number, fees: FeeSchedule = feeSchedule()): number {
  if (!(amount > 0)) return 0;
  const brokerage = (amount * fees.brokeragePct) / 100;
  const vat = (brokerage * fees.vatPct) / 100;
  const market = (amount * (fees.brvmPct + fees.dcbrPct)) / 100;
  return Math.max(fees.minFee, brokerage + vat + market);
}

/** Coût proportionnel d'un sens (décimal), hors minimum de perception. */
export function oneWayCostRate(fees: FeeSchedule = feeSchedule()): number {
  return (fees.brokeragePct * (1 + fees.vatPct / 100) + fees.brvmPct + fees.dcbrPct) / 100;
}

/** Coût d'un aller-retour (décimal). */
export function roundTripCostRate(fees: FeeSchedule = feeSchedule()): number {
  return 2 * oneWayCostRate(fees);
}

/** Retenue à la source sur les dividendes des sociétés cotées, % par pays de l'émetteur (indicatif). */
export const DEFAULT_DIVIDEND_TAX_PCT: Record<string, number> = { CI: 10, SN: 10, BF: 6, ML: 10, NE: 10, BJ: 7, TG: 7, GW: 10 };

export function dividendTaxPct(country: string): number {
  const table = parseJson(process.env.DIVIDEND_TAX_JSON, DEFAULT_DIVIDEND_TAX_PCT);
  return table[country] ?? 10;
}

export function netDividend(gross: number, country: string): number {
  return gross * (1 - dividendTaxPct(country) / 100);
}

export interface LiquidityPolicy {
  /** part maximale des capitaux échangés chaque jour qu'on accepte de représenter */
  participation: number;
  /** nombre de séances pour solder la ligne */
  exitDays: number;
}

export const DEFAULT_LIQUIDITY: LiquidityPolicy = { participation: 0.25, exitDays: 10 };

/** Plafond de poids d'une valeur (décimal) pour un capital donné ; 1 si le capital est négligeable devant les échanges. */
export function liquidityCap(capital: number, dailyTradedValue: number, policy: LiquidityPolicy = DEFAULT_LIQUIDITY): number {
  if (!(capital > 0) || !(dailyTradedValue > 0)) return 1;
  const maxPosition = dailyTradedValue * policy.participation * policy.exitDays;
  return Math.max(0, Math.min(1, maxPosition / capital));
}

/** Nombre de séances nécessaires pour solder une position à la participation donnée. */
export function daysToExit(positionValue: number, dailyTradedValue: number, participation = DEFAULT_LIQUIDITY.participation): number {
  if (!(positionValue > 0)) return 0;
  if (!(dailyTradedValue > 0)) return Infinity;
  return positionValue / (dailyTradedValue * participation);
}
