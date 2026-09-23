/**
 * Moteur de conseil « Kraken » : croise l'analyse technique de chaque valeur, le profil
 * comportemental de l'investisseur et l'état de son portefeuille pour produire des
 * recommandations personnalisées, un diagnostic de portefeuille et un dimensionnement de position.
 */
import { INSTRUMENT_MAP, INSTRUMENTS, type InstrumentDef } from "../data/instruments.js";
import type { BehaviorProfile, PositionRecord } from "./behavior.js";
import type { TechnicalSnapshot } from "./technical.js";

export type Action = "ACHAT FORT" | "ACHAT" | "CONSERVER" | "ALLÉGER" | "VENTE" | "ÉVITER";

export interface Recommendation {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  action: Action;
  score: number; // -100..100
  confidence: number; // 0..1
  fitScore: number; // adéquation au profil 0..100
  targetPrice: number;
  stopLoss: number;
  suggestedQuantity: number;
  suggestedAmount: number;
  expectedReturnPct: number;
  riskRewardRatio: number;
  horizon: string;
  rationale: string[];
  warnings: string[];
  dividendYield: number;
  held: boolean;
}

export interface PortfolioDiagnostic {
  totalValue: number;
  cash: number;
  invested: number;
  cashRatio: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  lines: number;
  sectorExposure: { sector: string; weightPct: number }[];
  diversificationScore: number; // 0..100
  riskScore: number; // 0..100 (100 = très risqué)
  healthScore: number; // 0..100
  suggestions: string[];
  rebalancing: { symbol: string; action: "renforcer" | "alléger" | "vendre" | "initier"; reason: string; weightPct: number }[];
}

export interface NewsContext {
  score: number; // -1..1
  count: number;
  headlines: { title: string; sentiment: number; source: string }[];
}

interface Context {
  profile: BehaviorProfile;
  positions: PositionRecord[];
  cash: number;
  /** Sentiment de l'actualité récente par valeur (veille presse / BRVM) */
  news?: Map<string, NewsContext>;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r0 = (v: number) => Math.round(v);
const r1 = (v: number) => Math.round(v * 10) / 10;

export function recommend(tech: TechnicalSnapshot, ctx: Context): Recommendation {
  const inst = INSTRUMENT_MAP.get(tech.symbol)!;
  const { profile } = ctx;
  const w = profile.weights;
  const s = tech.scores;
  const held = ctx.positions.some((p) => p.symbol === tech.symbol && p.quantity > 0);
  const position = ctx.positions.find((p) => p.symbol === tech.symbol);
  const rationale: string[] = [];
  const warnings: string[] = [];

  // Score dividende normalisé [-1, 1] autour de 5 %
  const divScore = clamp((inst.dividendYield - 5) / 5, -1, 1);

  let raw = s.trend * w.trend + s.momentum * w.momentum + s.meanReversion * w.meanReversion + s.volume * w.volume + s.risk * w.risk + divScore * w.dividend;

  // Adéquation profil / valeur
  let fit = 60;
  const riskTol = profile.effectiveRiskTolerance;
  const volPenalty = tech.volatility60 > 0.35 ? (tech.volatility60 - 0.35) * 100 : 0;
  fit -= volPenalty * (5 - riskTol) * 0.6;
  if (profile.declared.preferredSectors.includes(inst.sector)) fit += 10;
  if (profile.declared.objective === "income") fit += (inst.dividendYield - 4) * 4;
  if (profile.declared.objective === "speculative") fit += tech.volatility60 * 30;
  if (inst.avgVolume < 1500 && riskTol < 4) {
    fit -= 15;
    warnings.push("Liquidité faible : entrer et sortir peut prendre plusieurs séances");
  }
  if (profile.declared.horizonMonths < 12 && Math.abs(s.momentum) < 0.15) fit -= 10;
  fit = clamp(fit, 0, 100);

  // Ajustement du score par l'adéquation
  raw = raw * (0.6 + 0.4 * (fit / 100));
  if (fit < 35) raw = Math.min(raw, 0.1);

  // Contexte portefeuille : ne pas renforcer une ligne déjà lourde
  const totalValue = ctx.cash + ctx.positions.reduce((a, p) => a + p.quantity * p.currentPrice, 0);
  const lineWeight = position && totalValue > 0 ? (position.quantity * position.currentPrice) / totalValue : 0;
  if (lineWeight > 0.25 && raw > 0) {
    raw *= 0.5;
    warnings.push(`Ligne déjà lourde (${(lineWeight * 100).toFixed(0)} % du portefeuille)`);
  }

  // Actualité : tempère le score technique (jusqu'à ±12 points) et alimente l'explication
  const news = ctx.news?.get(tech.symbol);
  let newsPenalty = 0;
  if (news && news.count > 0 && Math.abs(news.score) >= 0.15) {
    raw = clamp(raw + news.score * 0.12, -1, 1);
    const head = news.headlines[0];
    if (news.score > 0) rationale.push(`Actualité récente favorable (${news.count} article${news.count > 1 ? "s" : ""}) : « ${head?.title ?? ""} »`);
    else {
      warnings.push(`Actualité récente défavorable (${news.count} article${news.count > 1 ? "s" : ""}) : « ${head?.title ?? ""} »`);
      newsPenalty = Math.min(0.2, Math.abs(news.score) * 0.25);
    }
  }
  const score = r0(clamp(raw, -1, 1) * 100);

  // Confiance : accord entre les composantes + profondeur d'historique
  const comps = [s.trend, s.momentum, s.volume];
  const agreement = comps.filter((c) => Math.sign(c) === Math.sign(raw) && Math.abs(c) > 0.1).length / comps.length;
  const confidence = clamp(0.35 + agreement * 0.45 + (tech.volatility60 < 0.3 ? 0.1 : 0) + Math.abs(raw) * 0.2 - newsPenalty, 0.2, 0.95);

  // Action
  let action: Action;
  if (fit < 30 && !held) action = "ÉVITER";
  else if (score >= 45) action = "ACHAT FORT";
  else if (score >= 18) action = "ACHAT";
  else if (score > -15) action = "CONSERVER";
  else if (score > -40) action = held ? "ALLÉGER" : "ÉVITER";
  else action = held ? "VENTE" : "ÉVITER";
  if (!held && action === "CONSERVER") action = score > 5 ? "ACHAT" : "CONSERVER";

  // Objectif / stop par ATR, adaptés au profil
  const atrMult = riskTol >= 4 ? 3 : riskTol >= 3 ? 2.5 : 2;
  const stop = Math.max(tech.support * 0.98, tech.price - atrMult * tech.atr14);
  const upside = Math.max(tech.resistance, tech.price + atrMult * 1.8 * tech.atr14);
  const targetPrice = roundTick(upside, tech.symbol);
  const stopLoss = roundTick(stop, tech.symbol);
  const negative = action === "ALLÉGER" || action === "VENTE" || action === "ÉVITER";
  // Potentiel : hausse vers l'objectif (+ dividendes) pour un avis positif, baisse vers le support pour un avis négatif
  const expectedReturnPct = negative
    ? Math.min(0, ((stopLoss - tech.price) / tech.price) * 100)
    : ((targetPrice - tech.price) / tech.price) * 100 + inst.dividendYield * (profile.declared.horizonMonths / 12) * 0.5;
  const riskRewardRatio = tech.price - stopLoss > 0 ? (targetPrice - tech.price) / (tech.price - stopLoss) : 0;

  // Dimensionnement : risque max par position selon la tolérance (0,5 % à 3 % du capital)
  const riskBudgetPct = [0.005, 0.01, 0.015, 0.02, 0.03][Math.round(riskTol) - 1] ?? 0.015;
  const riskPerShare = Math.max(tech.price - stopLoss, tech.price * 0.03);
  const maxByRisk = Math.floor((totalValue * riskBudgetPct) / riskPerShare);
  const maxByWeight = Math.floor((totalValue * (riskTol >= 4 ? 0.2 : 0.12)) / tech.price);
  const maxByCash = Math.floor((ctx.cash * 0.95) / tech.price);
  const suggestedQuantity = action.startsWith("ACHAT") ? Math.max(0, Math.min(maxByRisk, maxByWeight, maxByCash)) : 0;

  // Explications
  if (s.trend > 0.3) rationale.push("Tendance de fond haussière : cours au-dessus de ses moyennes mobiles 50 et 200");
  if (s.trend < -0.3) rationale.push("Tendance de fond baissière : cours sous ses moyennes mobiles clés");
  if (s.momentum > 0.3) rationale.push(`Momentum positif (RSI ${tech.rsi14.toFixed(0)}, +${tech.perf1m.toFixed(1)} % sur 1 mois)`);
  if (s.momentum < -0.3) rationale.push(`Momentum négatif (RSI ${tech.rsi14.toFixed(0)}, ${tech.perf1m.toFixed(1)} % sur 1 mois)`);
  if (s.meanReversion > 0.3) rationale.push("Survente technique : potentiel de rebond");
  if (s.meanReversion < -0.3) rationale.push("Surachat technique : risque de consolidation");
  if (s.volume > 0.3) rationale.push(s.trend >= 0 ? "Volumes en hausse qui confirment la progression" : "Volumes en hausse qui accompagnent la baisse : pression vendeuse");
  if (inst.dividendYield >= 6) rationale.push(`Rendement du dividende attractif (${inst.dividendYield.toFixed(1)} %)`);
  if (s.risk > 0.4) rationale.push("Valeur peu volatile, adaptée à un profil prudent");
  if (fit >= 75) rationale.push(`Bonne adéquation avec votre profil ${profile.style.toLowerCase()}`);
  if (fit < 35) warnings.push(`Faible adéquation avec votre profil ${profile.style.toLowerCase()} (${r0(fit)}/100)`);
  for (const sig of tech.signals.slice(0, 3)) rationale.push(sig);
  if (profile.biases.some((b) => b.code === "chasing") && tech.perf1w > 8) {
    warnings.push("Attention à votre tendance à acheter après une forte hausse : +" + tech.perf1w.toFixed(1) + " % cette semaine");
  }
  if (position && position.currentPrice < position.avgPrice * 0.85 && action !== "VENTE") {
    warnings.push("Ligne en perte de plus de 15 % : vérifiez que la thèse d'investissement tient toujours");
  }

  const horizon = profile.declared.horizonMonths >= 24 ? "12 à 24 mois" : profile.declared.horizonMonths >= 12 ? "6 à 12 mois" : "1 à 3 mois";

  return {
    symbol: tech.symbol,
    name: inst.name,
    sector: inst.sector,
    price: tech.price,
    action,
    score,
    confidence: Math.round(confidence * 100) / 100,
    fitScore: r0(fit),
    targetPrice,
    stopLoss,
    suggestedQuantity,
    suggestedAmount: r0(suggestedQuantity * tech.price),
    expectedReturnPct: r1(expectedReturnPct),
    riskRewardRatio: r1(riskRewardRatio),
    horizon,
    rationale,
    warnings,
    dividendYield: inst.dividendYield,
    held,
  };
}

export function diagnosePortfolio(ctx: Context, recs: Map<string, Recommendation>): PortfolioDiagnostic {
  const invested = ctx.positions.reduce((a, p) => a + p.quantity * p.currentPrice, 0);
  const cost = ctx.positions.reduce((a, p) => a + p.quantity * p.avgPrice, 0);
  const totalValue = ctx.cash + invested;
  const sectors = new Map<string, number>();
  for (const p of ctx.positions) sectors.set(p.sector, (sectors.get(p.sector) ?? 0) + p.quantity * p.currentPrice);
  const sectorExposure = [...sectors.entries()]
    .map(([sector, v]) => ({ sector, weightPct: r1(invested ? (v / invested) * 100 : 0) }))
    .sort((a, b) => b.weightPct - a.weightPct);

  // Diversification : Herfindahl sur lignes et secteurs
  const weights = ctx.positions.map((p) => (invested ? (p.quantity * p.currentPrice) / invested : 0));
  const hhiLines = weights.reduce((a, w) => a + w * w, 0);
  const hhiSectors = [...sectors.values()].reduce((a, v) => a + (invested ? (v / invested) ** 2 : 0), 0);
  const diversificationScore = ctx.positions.length === 0 ? 0 : r0(clamp((1 - hhiLines) * 70 + (1 - hhiSectors) * 30, 0, 100) * 1.15);

  // Risque : volatilité pondérée + concentration + cash
  let weightedVol = 0;
  for (const p of ctx.positions) {
    const inst = INSTRUMENT_MAP.get(p.symbol);
    weightedVol += (inst?.volatility ?? 0.3) * (totalValue ? (p.quantity * p.currentPrice) / totalValue : 0);
  }
  const riskScore = r0(clamp(weightedVol * 200 + hhiLines * 30, 0, 100));
  const cashRatio = totalValue ? ctx.cash / totalValue : 1;

  const suggestions: string[] = [];
  const rebalancing: PortfolioDiagnostic["rebalancing"] = [];
  const tol = ctx.profile.effectiveRiskTolerance;
  const targetCash = tol >= 4 ? 0.1 : tol >= 3 ? 0.15 : 0.3;
  if (cashRatio > targetCash + 0.25 && totalValue > 0) {
    suggestions.push(`${r0(cashRatio * 100)} % de liquidités non investies : pour votre profil ${ctx.profile.style.toLowerCase()}, une réserve d'environ ${r0(targetCash * 100)} % suffit.`);
  }
  if (cashRatio < 0.05 && totalValue > 0) suggestions.push("Peu de liquidités : gardez une réserve pour saisir les opportunités ou absorber un choc.");
  if (ctx.positions.length > 0 && ctx.positions.length < 5) suggestions.push("Moins de 5 lignes : élargissez progressivement à 6 – 10 valeurs sur 3 secteurs différents.");
  if (riskScore > 65 && tol < 3) suggestions.push("Le risque du portefeuille dépasse votre tolérance : réduisez les valeurs les plus volatiles.");
  if (riskScore < 30 && tol >= 4) suggestions.push("Portefeuille très défensif pour un profil dynamique : une poche de valeurs de croissance peut être envisagée.");

  for (const p of ctx.positions) {
    const rec = recs.get(p.symbol);
    if (!rec) continue;
    const w = totalValue ? ((p.quantity * p.currentPrice) / totalValue) * 100 : 0;
    if (rec.action === "VENTE") rebalancing.push({ symbol: p.symbol, action: "vendre", reason: rec.rationale[0] ?? "Signal technique négatif", weightPct: r1(w) });
    else if (rec.action === "ALLÉGER" || w > 30) rebalancing.push({ symbol: p.symbol, action: "alléger", reason: w > 30 ? "Poids excessif dans le portefeuille" : (rec.rationale[0] ?? "Momentum défavorable"), weightPct: r1(w) });
    else if (rec.action === "ACHAT FORT" && w < 15) rebalancing.push({ symbol: p.symbol, action: "renforcer", reason: rec.rationale[0] ?? "Signal fort", weightPct: r1(w) });
  }
  // Nouvelles idées non détenues
  const ideas = [...recs.values()]
    .filter((r) => !r.held && r.action === "ACHAT FORT" && r.fitScore >= 55)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  for (const r of ideas) rebalancing.push({ symbol: r.symbol, action: "initier", reason: r.rationale[0] ?? "Opportunité", weightPct: 0 });

  const unrealizedPnl = invested - cost;
  const healthScore = r0(clamp(diversificationScore * 0.4 + (100 - Math.abs(riskScore - tol * 18)) * 0.3 + clamp(50 + (cost ? (unrealizedPnl / cost) * 100 : 0), 0, 100) * 0.3, 0, 100));

  return {
    totalValue: r0(totalValue),
    cash: r0(ctx.cash),
    invested: r0(invested),
    cashRatio: r1(cashRatio * 100),
    unrealizedPnl: r0(unrealizedPnl),
    unrealizedPnlPct: r1(cost ? (unrealizedPnl / cost) * 100 : 0),
    lines: ctx.positions.length,
    sectorExposure,
    diversificationScore,
    riskScore,
    healthScore,
    suggestions,
    rebalancing,
  };
}

/** Allocation cible proposée à partir des meilleures recommandations. */
export function proposeAllocation(recs: Recommendation[], profile: BehaviorProfile, capital: number): { symbol: string; name: string; weightPct: number; amount: number; quantity: number }[] {
  const tol = profile.effectiveRiskTolerance;
  const maxLines = tol >= 4 ? 6 : 8;
  const candidates = recs
    .filter((r) => r.action === "ACHAT" || r.action === "ACHAT FORT")
    .filter((r) => r.fitScore >= 45)
    .sort((a, b) => b.score * b.confidence - a.score * a.confidence);
  const chosen: Recommendation[] = [];
  const sectorCount = new Map<string, number>();
  for (const r of candidates) {
    const c = sectorCount.get(r.sector) ?? 0;
    if (c >= 3) continue;
    chosen.push(r);
    sectorCount.set(r.sector, c + 1);
    if (chosen.length >= maxLines) break;
  }
  const cashReserve = tol >= 4 ? 0.1 : tol >= 3 ? 0.15 : 0.3;
  const investable = capital * (1 - cashReserve);
  const totalScore = chosen.reduce((a, r) => a + Math.max(1, r.score), 0) || 1;
  return chosen.map((r) => {
    const weight = Math.min(0.25, Math.max(1, r.score) / totalScore);
    const amount = investable * weight;
    const quantity = Math.floor(amount / r.price);
    return { symbol: r.symbol, name: r.name, weightPct: r1(weight * 100), amount: r0(quantity * r.price), quantity };
  });
}

export function instrumentOf(symbol: string): InstrumentDef | undefined {
  return INSTRUMENT_MAP.get(symbol);
}

export function allInstruments(): InstrumentDef[] {
  return INSTRUMENTS;
}

function roundTick(price: number, symbol: string): number {
  if (symbol === "ETIT") return Math.max(1, Math.round(price));
  if (price < 1000) return Math.max(5, Math.round(price / 5) * 5);
  return Math.round(price);
}
