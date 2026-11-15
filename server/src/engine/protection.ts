/**
 * Superposition de protection du moteur court terme (étape 3) : régime de marché et CPPI.
 *
 * Régime : lu sur l'indice composite à une date, sans rien regarder au-delà. Tendance (clôture contre
 * moyenne 50 et 200 séances, momentum 3 mois), tension (volatilité 20 séances rapportée à sa médiane
 * sur un an) et repli depuis le plus haut d'un an. Quatre états, chacun avec un multiplicateur
 * d'exposition : haussier 1, neutre 0,75, baissier 0,5, stress 0,25.
 *
 * CPPI à plancher cliquet (TIPP) : le plancher vaut une part fixe du plus haut atteint par le
 * portefeuille (85 % par défaut) et ne redescend jamais ; le coussin est l'écart entre la valeur et le
 * plancher ; l'exposition autorisée est le coussin multiplié par m (4 par défaut), bornée à 100 % (pas
 * de levier), puis multipliée par le facteur de régime. Après une série de pertes l'exposition baisse
 * d'elle-même ; elle remonte quand le capital se reconstitue. C'est ce qui autorise des positions
 * concentrées sans risque de ruine.
 */
import { sma } from "./indicators.js";

export type RegimeKey = "haussier" | "neutre" | "baissier" | "stress";

export interface Regime {
  key: RegimeKey;
  label: string;
  /** facteur appliqué à l'exposition autorisée */
  multiplier: number;
  /** indicateurs lus à la date */
  mom63Pct: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  volRatio: number | null;
  drawdownPct: number | null;
  reasons: string[];
}

export const REGIME_MULTIPLIER: Record<RegimeKey, number> = { haussier: 1, neutre: 0.75, baissier: 0.5, stress: 0.25 };
export const REGIME_LABEL: Record<RegimeKey, string> = { haussier: "Haussier", neutre: "Neutre", baissier: "Baissier", stress: "Stress" };

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
}

/** Régime de marché à l'indice `t` d'une série de clôtures de l'indice (n'utilise que les données ≤ t). */
export function regimeAt(index: number[], t: number): Regime {
  const n = t + 1;
  const neutral: Regime = { key: "neutre", label: REGIME_LABEL.neutre, multiplier: REGIME_MULTIPLIER.neutre, mom63Pct: null, aboveSma50: null, aboveSma200: null, volRatio: null, drawdownPct: null, reasons: ["historique de l'indice insuffisant"] };
  if (n < 70 || !(index[t] > 0)) return neutral;
  const c = index[t];
  const s50 = sma(index.slice(0, n), 50)[t];
  const s200 = n >= 200 ? sma(index.slice(0, n), 200)[t] : NaN;
  const mom63 = index[t - 63] > 0 ? Math.log(c / index[t - 63]) : 0;
  const lr: number[] = [];
  for (let i = Math.max(1, t - 251); i <= t; i++) if (index[i - 1] > 0 && index[i] > 0) lr.push(Math.log(index[i] / index[i - 1]));
  const vol20 = stdev(lr.slice(-20));
  const vols: number[] = [];
  for (let k = 20; k <= lr.length; k += 5) vols.push(stdev(lr.slice(k - 20, k)));
  const volMed = median(vols) || vol20 || 1e-9;
  const volRatio = vol20 / volMed;
  const peak = Math.max(...index.slice(Math.max(0, t - 251), n));
  const drawdown = peak > 0 ? c / peak - 1 : 0;
  const aboveSma50 = Number.isFinite(s50) ? c > s50 : null;
  const aboveSma200 = Number.isFinite(s200) ? c > s200 : null;
  const reasons: string[] = [];
  let key: RegimeKey;
  if (volRatio >= 1.8 || drawdown <= -0.15) {
    key = "stress";
    reasons.push(volRatio >= 1.8 ? `volatilité ×${volRatio.toFixed(1)} sa médiane` : `repli de ${(drawdown * 100).toFixed(1)} % depuis le plus haut`);
  } else if (mom63 < -0.03 && aboveSma50 === false) {
    key = "baissier";
    reasons.push(`momentum 3 mois ${(mom63 * 100).toFixed(1)} %`, "indice sous sa moyenne 50 séances");
  } else if (mom63 > 0.02 && aboveSma50 !== false && aboveSma200 !== false) {
    key = "haussier";
    reasons.push(`momentum 3 mois +${(mom63 * 100).toFixed(1)} %`, aboveSma200 ? "indice au-dessus de ses moyennes 50 et 200" : "indice au-dessus de sa moyenne 50");
  } else {
    key = "neutre";
    reasons.push(`momentum 3 mois ${mom63 >= 0 ? "+" : ""}${(mom63 * 100).toFixed(1)} %`, aboveSma50 === false ? "indice sous sa moyenne 50" : "tendance sans conviction");
  }
  return { key, label: REGIME_LABEL[key], multiplier: REGIME_MULTIPLIER[key], mom63Pct: Math.round(mom63 * 1000) / 10, aboveSma50, aboveSma200, volRatio: Math.round(volRatio * 100) / 100, drawdownPct: Math.round(drawdown * 1000) / 10, reasons };
}

export interface CppiConfig {
  /** plancher en part du plus haut atteint (cliquet) */
  floorPct: number;
  /** multiplicateur du coussin */
  multiplier: number;
  /** exposition maximale (1 = pas de levier) */
  maxExposure: number;
}

export const DEFAULT_CPPI: CppiConfig = { floorPct: 0.85, multiplier: 4, maxExposure: 1 };

export interface CppiState {
  value: number;
  peak: number;
  floor: number;
  cushion: number;
  /** exposition autorisée avant régime (décimal de la valeur) */
  rawExposure: number;
  /** exposition autorisée après régime */
  exposure: number;
  /** montant investissable */
  budget: number;
}

/** État CPPI pour une valeur de portefeuille, son plus haut et un facteur de régime. */
export function cppiState(value: number, peak: number, regimeMultiplier = 1, cfg: CppiConfig = DEFAULT_CPPI): CppiState {
  const pk = Math.max(peak, value);
  const floor = cfg.floorPct * pk;
  const cushion = Math.max(0, value - floor);
  const raw = value > 0 ? Math.min(cfg.maxExposure, (cfg.multiplier * cushion) / value) : 0;
  const exposure = Math.round(raw * Math.max(0, Math.min(1, regimeMultiplier)) * 1000) / 1000;
  return { value, peak: pk, floor, cushion, rawExposure: Math.round(raw * 1000) / 1000, exposure, budget: exposure * value };
}

/** Réduit proportionnellement des poids (en %) pour que leur somme ne dépasse pas `capPct`. */
export function capWeights<T extends { weightPct: number }>(lines: T[], capPct: number): T[] {
  const total = lines.reduce((a, l) => a + l.weightPct, 0);
  if (total <= capPct || total <= 0) return lines;
  const k = capPct / total;
  return lines.map((l) => ({ ...l, weightPct: Math.round(l.weightPct * k * 10) / 10 }));
}
