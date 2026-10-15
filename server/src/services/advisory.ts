import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../data/instruments.js";
import { SGI_MAP } from "../data/sgi.js";
import { buildBehaviorProfile, type DeclaredProfile, type PositionRecord } from "../engine/behavior.js";
import { diagnosePortfolio, proposeAllocation, recommend, type PortfolioDiagnostic, type Recommendation } from "../engine/advisor.js";
import type { AdvisorService } from "./advisor.js";
import type { MarketService } from "./market.js";
import type { NewsService } from "./news.js";
import type { ForecastService } from "./forecast.js";
import { optimize, type OptimizationResult } from "../engine/optimizer.js";
import type { Forecast } from "../engine/forecast.js";
import { targetBondSharePct, type BondAllocationLine, type BondService } from "./bonds.js";

/** Taux sans risque annuel de référence (obligations d'État UEMOA, indicatif) : RISK_FREE_RATE=0.06 */
export const RISK_FREE_RATE = Number(process.env.RISK_FREE_RATE ?? 0.06);

export type RequesterType = "client" | "sgi";
export type AdvisoryStatus = "generated" | "validated" | "declined";

export interface Holding {
  symbol: string;
  quantity: number;
  avgPrice?: number;
}

export interface AdvisoryInput {
  capital: number;
  objective: DeclaredProfile["objective"];
  horizonMonths: number;
  riskTolerance: number;
  preferredSectors?: string[];
  constraints?: string;
  holdings?: Holding[];
  /** Pour une SGI : identifiant du client ou du portefeuille concerné */
  clientLabel?: string;
  /** Rendement annuel total visé (%), dividendes inclus : l'optimiseur cherche le portefeuille le moins risqué qui l'atteint */
  targetYieldPct?: number;
  /** Nombre maximal de lignes souhaité */
  maxLines?: number;
  /** Poids maximal d'une ligne (%) */
  maxWeightPct?: number;
  excludedSectors?: string[];
  excludedSymbols?: string[];
  /** Part du capital à placer en obligations (%) ; absent = selon le profil, 0 = aucune */
  bondSharePct?: number;
}

export interface BondSleeve {
  targetSharePct: number;
  sharePct: number;
  amount: number;
  lines: BondAllocationLine[];
  annualCoupons: number;
  avgYieldPct: number;
  avgDurationYears: number;
  rationale: string[];
}

export interface LineForecast {
  symbol: string;
  expectedReturn3MPct: number;
  probUp3M: number;
  hitRate3M: number;
  p5: number;
  p95: number;
  explanation: string | null;
}

export interface OptimizationSummary {
  method: "optimizer" | "heuristic";
  targetYieldPct: number | null;
  reachedTarget: boolean;
  maxAchievablePct: number;
  expectedAnnualReturnPct: number;
  volatilityPct: number;
  sharpe: number;
  dividendYieldPct: number;
  minVolatilityPct: number;
  riskFreePct: number;
  constraints: { maxWeightPct: number; maxSectorWeightPct: number; maxLines: number; investedMaxPct: number; excludedSectors: string[]; excludedSymbols: string[] };
  frontier: { targetReturnPct: number; volatilityPct: number; expectedReturnPct: number }[];
  notes: string[];
}

export interface AllocationLine {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  quantity: number;
  amount: number;
  weightPct: number;
  dividendYield: number;
  expectedReturnPct: number;
  fitScore: number;
  rationale: string[];
}

export interface AdvisoryReport {
  generatedAt: number;
  style: string;
  capital: number;
  investable: number;
  cashReserve: number;
  cashReservePct: number;
  allocation: AllocationLine[];
  sectorBreakdown: { sector: string; weightPct: number }[];
  metrics: {
    lines: number;
    expectedDividendYieldPct: number;
    expectedReturnPct: number; // sur l'horizon, dividendes inclus
    annualizedReturnPct: number;
    estimatedVolatilityPct: number; // annualisée
    maxLineWeightPct: number;
    annualDividendIncome: number;
  };
  scenarios: { pessimistic: number; central: number; optimistic: number; horizonMonths: number };
  existing: { diagnostic: PortfolioDiagnostic; actions: PortfolioDiagnostic["rebalancing"] } | null;
  /** Actualité prise en compte : sentiment de place et titres marquants */
  newsContext: { marketSentiment: number; marketCount: number; headlines: { title: string; sentiment: number; source: string; url: string; published_at: number }[] };
  /** Optimisation moyenne-variance : cible, faisabilité, frontière efficiente */
  optimization: OptimizationSummary;
  /** Prévisions probabilistes des valeurs retenues */
  forecasts: LineForecast[];
  /** Poche obligataire (emprunts d'État, BOAD, entreprises) */
  bonds: BondSleeve;
  summary: string[];
  warnings: string[];
}

export interface AdvisoryRequest {
  id: number;
  user_id: number;
  requester_type: RequesterType;
  sgi_code: string | null;
  client_label: string | null;
  capital: number;
  objective: string;
  horizon_months: number;
  risk_tolerance: number;
  preferred_sectors: string;
  constraints: string | null;
  holdings: string;
  status: AdvisoryStatus;
  report: string;
  analyst_id: number | null;
  analyst_note: string | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
  requester_name?: string;
  requester_email?: string;
}

export interface AdvisoryView extends Omit<AdvisoryRequest, "report" | "preferred_sectors" | "holdings"> {
  report: AdvisoryReport;
  preferred_sectors: string[];
  holdings: Holding[];
}

const r0 = (v: number) => Math.round(v);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Guichet de conseil en investissement : un client ou une SGI (pour le compte d'un de ses
 * clients) décrit un placement à réaliser ; le moteur Kraken produit une proposition
 * d'allocation motivée, chiffrée et scénarisée, qu'un analyste peut ensuite valider ou annoter.
 */
export class AdvisoryService extends EventEmitter {
  private newsService: NewsService | null = null;
  private forecasts: ForecastService | null = null;
  private bonds: BondService | null = null;

  constructor(
    private readonly db: DB,
    private readonly market: MarketService,
    private readonly advisor: AdvisorService,
  ) {
    super();
  }

  attachNews(news: NewsService): void {
    this.newsService = news;
  }

  attachForecasts(fc: ForecastService): void {
    this.forecasts = fc;
  }

  attachBonds(b: BondService): void {
    this.bonds = b;
  }

  /**
   * Rendement annuel attendu d'une valeur pour l'optimiseur : dividende + espérance de cours.
   * L'espérance de cours mélange la prévision 3 mois annualisée (pondérée par sa confiance) et
   * l'objectif de cours de l'analyse technique, bornée à ±40 %.
   */
  private expectedAnnualReturn(rec: Recommendation, fc: Forecast | undefined, horizonMonths: number): number {
    const techPrice = ((rec.targetPrice - rec.price) / rec.price) * (12 / Math.max(6, horizonMonths));
    let price = techPrice;
    if (fc) {
      const h3 = fc.horizons[2];
      const fcAnnual = Math.max(-0.4, Math.min(0.4, (h3.expectedReturnPct / 100) * 4));
      const w = 0.4 + 0.4 * h3.confidence;
      price = fcAnnual * w + techPrice * (1 - w);
    }
    return Math.max(-0.4, Math.min(0.4, price)) + rec.dividendYield / 100;
  }

  /** Génère le rapport (sans le persister). */
  generateReport(input: AdvisoryInput): AdvisoryReport {
    if (!(input.capital > 0)) throw new Error("Le capital à placer doit être positif");
    const declared: DeclaredProfile = {
      riskTolerance: Math.max(1, Math.min(5, Math.round(input.riskTolerance))),
      horizonMonths: Math.max(1, Math.round(input.horizonMonths)),
      objective: input.objective,
      experience: "intermediate",
      monthlyCapacity: 0,
      preferredSectors: input.preferredSectors ?? [],
    };
    const positions: PositionRecord[] = (input.holdings ?? [])
      .filter((h) => INSTRUMENT_MAP.has(h.symbol) && h.quantity > 0)
      .map((h) => {
        const price = this.market.price(h.symbol) || INSTRUMENT_MAP.get(h.symbol)!.refPrice;
        return { symbol: h.symbol, quantity: h.quantity, avgPrice: h.avgPrice ?? price, currentPrice: price, sector: INSTRUMENT_MAP.get(h.symbol)!.sector };
      });
    const profile = buildBehaviorProfile(declared, [], [], positions);
    const ctx = { profile, positions, cash: input.capital, news: this.advisor.newsContext?.() ?? new Map() };
    const recs = INSTRUMENTS.map((i) => recommend(this.advisor.technical(i.symbol), ctx)).sort((a, b) => b.score - a.score);
    const recMap = new Map(recs.map((r) => [r.symbol, r]));
    const existingValue = positions.reduce((a, p) => a + p.quantity * p.currentPrice, 0);
    const tol = profile.effectiveRiskTolerance;
    const market = this.newsService?.marketSentiment() ?? { score: 0, count: 0, headlines: [] };
    // Part obligataire cible : selon le profil (ou demandée) ; elle assure la fonction défensive, la réserve de liquidités est alors ramenée à 10–15 %
    const targetBondShare = input.bondSharePct != null ? Math.max(0, Math.min(80, input.bondSharePct)) : targetBondSharePct(tol, declared.objective, declared.horizonMonths);
    const baseReserve = tol >= 4 ? 10 : tol >= 3 ? 15 : 30;
    // actualité de place défavorable : réserve de liquidités relevée de 5 points
    const cashReservePct = (targetBondShare > 0 && this.bonds ? Math.max(10, baseReserve - targetBondShare / 2) : baseReserve) + (market.score <= -0.2 ? 5 : 0);

    // ---- Optimisation moyenne-variance sous contraintes ----
    const fcMap = this.forecasts?.all() ?? new Map<string, Forecast>();
    const excludedSectors = input.excludedSectors ?? [];
    const excludedSymbols = (input.excludedSymbols ?? []).map((x) => x.toUpperCase());
    const maxLines = Math.max(2, Math.min(15, Math.round(input.maxLines ?? (tol >= 4 ? 6 : 8))));
    const maxWeight = Math.max(5, Math.min(60, input.maxWeightPct ?? 25)) / 100;
    const maxSectorWeight = Math.min(1, Math.max(maxWeight, tol >= 4 ? 0.6 : 0.45));
    // ---- Poche obligataire : part cible selon le profil (ou demandée), sélection d'émissions ----
    const existingBonds = (input.holdings ?? []).filter((h) => this.bonds?.has(h.symbol)).reduce((a, h) => {
      const v = this.bonds!.view(h.symbol)!;
      return a + h.quantity * (v.quote.price + v.analytics.accrued);
    }, 0);
    const bondBudget = Math.max(0, (input.capital * targetBondShare) / 100 - existingBonds);
    const bondLines = this.bonds && bondBudget > 20_000 ? this.bonds.suggest(bondBudget, declared.horizonMonths, 4, input.excludedSymbols?.map((x) => x.toUpperCase()), tol) : [];
    const bondAmount = bondLines.reduce((a, l) => a + l.amount, 0);
    const bondShare = input.capital ? (bondAmount / input.capital) * 100 : 0;
    const investedMax = Math.max(0.05, 1 - cashReservePct / 100 - bondShare / 100);
    const universe = recs.filter((r) => r.action !== "VENTE" && r.action !== "ÉVITER" && r.fitScore >= 30 && !excludedSectors.includes(r.sector) && !excludedSymbols.includes(r.symbol));
    const returnsBySymbol = new Map<string, number[]>();
    for (const r of universe) {
      const closes = this.market.history(r.symbol, 300).map((c) => c.close);
      if (closes.length >= 60) returnsBySymbol.set(r.symbol, closes.slice(1).map((v, k) => Math.log(v / closes[k])));
    }
    const assets = universe.map((r) => ({ symbol: r.symbol, sector: r.sector, expectedReturn: this.expectedAnnualReturn(r, fcMap.get(r.symbol), declared.horizonMonths), dividendYield: r.dividendYield / 100, price: r.price }));
    const target = input.targetYieldPct != null && input.targetYieldPct > 0 ? input.targetYieldPct / 100 : null;
    let opt: OptimizationResult | null = null;
    try {
      opt = optimize(assets, returnsBySymbol, { maxWeight, maxSectorWeight, maxLines, investedMax, excludedSectors, excludedSymbols }, target, RISK_FREE_RATE);
    } catch (e) {
      opt = null;
    }
    let method: OptimizationSummary["method"] = "optimizer";
    let proposal: { symbol: string; name: string; quantity: number; amount: number; weightPct: number }[] = [];
    if (opt && opt.feasible && opt.weights.length >= 2) {
      proposal = opt.weights
        .map((w) => {
          const rec = recMap.get(w.symbol)!;
          const amount = input.capital * w.weight;
          const quantity = Math.floor(amount / rec.price);
          return { symbol: w.symbol, name: rec.name, quantity, amount: quantity * rec.price, weightPct: r1(((quantity * rec.price) / input.capital) * 100) };
        })
        .filter((p) => p.quantity > 0);
    }
    if (proposal.length < 2) {
      method = "heuristic";
      proposal = proposeAllocation(recs.filter((r) => !excludedSectors.includes(r.sector) && !excludedSymbols.includes(r.symbol)), profile, input.capital);
    }

    const allocation: AllocationLine[] = proposal.map((p) => {
      const rec = recMap.get(p.symbol)!;
      const fc = fcMap.get(p.symbol);
      const rationale = rec.rationale.slice(0, 2);
      if (fc) rationale.push(`Prévision 3 mois : ${fc.horizons[2].expectedReturnPct > 0 ? "+" : ""}${fc.horizons[2].expectedReturnPct} % (hausse à ${Math.round(fc.horizons[2].probUp * 100)} %)`);
      return {
        symbol: p.symbol,
        name: p.name,
        sector: rec.sector,
        price: rec.price,
        quantity: p.quantity,
        amount: p.amount,
        weightPct: p.weightPct,
        dividendYield: rec.dividendYield,
        expectedReturnPct: rec.expectedReturnPct,
        fitScore: rec.fitScore,
        rationale: rationale.slice(0, 3),
      };
    });
    const forecastsOut: LineForecast[] = allocation.flatMap((l) => {
      const fc = fcMap.get(l.symbol);
      if (!fc) return [];
      const h = fc.horizons[2];
      return [{ symbol: l.symbol, expectedReturn3MPct: h.expectedReturnPct, probUp3M: h.probUp, hitRate3M: h.accuracy.hitRate, p5: h.quantiles.p5, p95: h.quantiles.p95, explanation: h.explanations[0] ?? null }];
    });
    const invested = allocation.reduce((a, l) => a + l.amount, 0);
    const cashReserve = input.capital - invested - bondAmount;
    const sectors = new Map<string, number>();
    for (const l of allocation) sectors.set(l.sector, (sectors.get(l.sector) ?? 0) + l.amount);
    const sectorBreakdown = [...sectors.entries()].map(([sector, v]) => ({ sector, weightPct: r1(invested ? (v / invested) * 100 : 0) })).sort((a, b) => b.weightPct - a.weightPct);

    // Métriques pondérées par montant
    const w = (l: AllocationLine) => (invested ? l.amount / invested : 0);
    const divYield = allocation.reduce((a, l) => a + l.dividendYield * w(l), 0);
    const horizonYears = declared.horizonMonths / 12;
    const usedOpt = method === "optimizer" && opt;
    // Avec l'optimiseur : rendement annuel = μ'w (prévision + dividende) ; volatilité issue de la covariance réelle
    const annualFromOpt = usedOpt ? (allocation.reduce((a, l) => a + (assets.find((x) => x.symbol === l.symbol)?.expectedReturn ?? 0) * w(l), 0)) * 100 : NaN;
    const expectedReturn = usedOpt ? (Math.pow(1 + annualFromOpt / 100, horizonYears) - 1) * 100 : allocation.reduce((a, l) => a + l.expectedReturnPct * w(l), 0);
    const annualized = usedOpt ? annualFromOpt : horizonYears > 0 ? (Math.pow(1 + expectedReturn / 100, 1 / horizonYears) - 1) * 100 : expectedReturn;
    const vol = usedOpt && opt!.invested > 0 ? opt!.volatility / opt!.invested : allocation.reduce((a, l) => a + (INSTRUMENT_MAP.get(l.symbol)?.volatility ?? 0.3) * w(l), 0) * 0.8; // diversification ≈ -20 %
    const maxLine = allocation.reduce((a, l) => Math.max(a, l.weightPct), 0);
    const horizonVol = vol * Math.sqrt(Math.max(0.25, horizonYears));
    const bondYield = bondAmount ? bondLines.reduce((a, l) => a + l.ytmPct * l.amount, 0) / bondAmount : 0;
    const bondDuration = bondAmount ? bondLines.reduce((a, l) => a + l.durationYears * l.amount, 0) / bondAmount : 0;
    const bondHorizonReturn = (Math.pow(1 + bondYield / 100, horizonYears) - 1) * 100;
    const bondsAtHorizon = bondAmount * (1 + bondHorizonReturn / 100);
    const central = invested * (1 + expectedReturn / 100) + bondsAtHorizon + cashReserve;
    // obligations : fourchette étroite (± duration × 1 point de taux, bornée)
    const bondSwing = bondAmount * Math.min(0.15, bondDuration * 0.01);
    const scenarios = {
      pessimistic: r0(Math.max(invested * 0.4, invested * (1 + expectedReturn / 100 - horizonVol)) + bondsAtHorizon - bondSwing + cashReserve),
      central: r0(central),
      optimistic: r0(invested * (1 + expectedReturn / 100 + horizonVol) + bondsAtHorizon + bondSwing + cashReserve),
      horizonMonths: declared.horizonMonths,
    };

    let existing: AdvisoryReport["existing"] = null;
    if (positions.length) {
      const diagnostic = diagnosePortfolio({ profile, positions, cash: input.capital }, recMap);
      existing = { diagnostic, actions: diagnostic.rebalancing };
    }

    const summary: string[] = [];
    const warnings: string[] = [];
    const objectiveLabel = { income: "de revenus réguliers", growth: "de croissance du capital", balanced: "équilibré revenus / croissance", speculative: "de plus-values rapides" }[declared.objective];
    summary.push(`Profil ${profile.style.toLowerCase()} avec un objectif ${objectiveLabel} sur ${declared.horizonMonths} mois : ${allocation.length} action(s) sur ${sectorBreakdown.length} secteur(s) (${r0((invested / input.capital) * 100)} %)${bondLines.length ? `, ${bondLines.length} obligation(s) (${r0(bondShare)} %)` : ""} et ${r0(cashReservePct)} % de réserve de liquidités recommandée.`);
    if (bondLines.length) summary.push(`Poche obligataire ${r0(bondAmount).toLocaleString("fr-FR")} FCFA : rendement actuariel moyen ${r2(bondYield)} %, duration ${r1(bondDuration)} ans, ${r0(bondLines.reduce((a, l) => a + l.annualCoupon, 0)).toLocaleString("fr-FR")} FCFA de coupons par an ; ${bondLines.every((l) => l.taxExempt) ? "emprunts d'État exonérés d'impôt" : bondLines.some((l) => l.taxExempt) ? "en partie exonérée d'impôt" : "soumise à l'impôt sur les revenus de valeurs mobilières"}.`);
    else if (targetBondShare > 0 && input.bondSharePct !== 0) warnings.push(`Aucune obligation retenue (budget obligataire ${r0(bondBudget).toLocaleString("fr-FR")} FCFA insuffisant ou aucune émission d'échéance compatible) : la part prévue est laissée en liquidités.`);
    if (allocation.length) summary.push(`Rendement de dividende attendu ${r1(divYield)} % par an (≈ ${r0((invested * divYield) / 100).toLocaleString("fr-FR")} FCFA), performance visée ${r1(expectedReturn)} % sur l'horizon (${r1(annualized)} % annualisé), volatilité estimée ${r0(vol * 100)} %.`);
    const top = allocation[0];
    const topFc = top ? fcMap.get(top.symbol) : undefined;
    if (top && method === "optimizer") summary.push(`Première ligne : ${top.name} (${top.weightPct} %), retenue pour son couple rendement attendu / risque${topFc ? ` ; prévision 3 mois ${topFc.horizons[2].expectedReturnPct > 0 ? "+" : ""}${topFc.horizons[2].expectedReturnPct} % (hausse à ${Math.round(topFc.horizons[2].probUp * 100)} %)` : ""}.`);
    else if (top) summary.push(`Première conviction : ${top.name} (${top.weightPct} %), ${top.rationale[0]?.toLowerCase() ?? "signal favorable"}.`);
    if (existing) {
      summary.push(`Portefeuille existant : santé ${existing.diagnostic.healthScore}/100, diversification ${existing.diagnostic.diversificationScore}/100, ${existing.actions.length} action(s) de rééquilibrage proposée(s).`);
      warnings.push(...existing.diagnostic.suggestions);
    }
    if (allocation.length < 4) warnings.push("Peu de valeurs répondent aux critères dans les conditions de marché actuelles : envisagez un déploiement progressif du capital.");
    if (input.capital < 500_000) warnings.push("Capital modeste : les frais fixes de courtage pèsent davantage ; limitez le nombre de lignes.");
    if (declared.horizonMonths < 12 && declared.objective !== "speculative") warnings.push("Horizon court pour un placement en actions BRVM (liquidité limitée) : une partie en obligations d'État UEMOA peut être plus adaptée.");
    if (input.constraints) summary.push(`Contraintes prises en compte : ${input.constraints}`);
    if (market.count > 0) {
      const tone = market.score <= -0.2 ? "défavorable" : market.score >= 0.2 ? "favorable" : "neutre";
      summary.push(`Actualité de place ${tone} sur 14 jours (${market.count} article${market.count > 1 ? "s" : ""}, sentiment ${market.score > 0 ? "+" : ""}${market.score})${market.score <= -0.2 ? " : réserve de liquidités relevée de 5 points et déploiement progressif conseillé" : ""}.`);
      if (market.score <= -0.2) warnings.push(`Contexte de marché défavorable : « ${market.headlines[0]?.title ?? ""} ». Échelonnez les achats sur plusieurs semaines.`);
    }
    const lineNews = allocation.filter((l) => l.rationale.some((x) => x.startsWith("Actualité")));
    if (lineNews.length) summary.push(`${lineNews.length} valeur(s) de l'allocation bénéficient d'une actualité récente favorable.`);

    const optimization: OptimizationSummary = {
      method,
      targetYieldPct: target != null ? r1(target * 100) : null,
      reachedTarget: opt ? opt.reachedTarget : false,
      maxAchievablePct: opt ? r1(opt.maxAchievableReturn * 100) : 0,
      expectedAnnualReturnPct: r1(usedOpt ? opt!.expectedReturn * 100 : annualized),
      volatilityPct: r1((usedOpt ? opt!.volatility : vol) * 100),
      sharpe: opt ? opt.sharpe : 0,
      dividendYieldPct: r1(usedOpt ? opt!.dividendYield * 100 : divYield),
      minVolatilityPct: opt ? r1(opt.minVolatility * 100) : 0,
      riskFreePct: r1(RISK_FREE_RATE * 100),
      constraints: { maxWeightPct: r0(maxWeight * 100), maxSectorWeightPct: r0(maxSectorWeight * 100), maxLines, investedMaxPct: r0(investedMax * 100), excludedSectors, excludedSymbols },
      frontier: opt ? opt.frontier.map((p) => ({ targetReturnPct: r1(p.targetReturn * 100), volatilityPct: r1(p.volatility * 100), expectedReturnPct: r1(p.expectedReturn * 100) })) : [],
      notes: opt ? [...opt.notes] : ["Optimiseur indisponible : allocation heuristique par score."],
    };
    if (method === "optimizer") {
      summary.push(`Allocation optimisée (moyenne-variance, covariance sur 300 séances) : ${optimization.expectedAnnualReturnPct} % de rendement annuel attendu pour ${optimization.volatilityPct} % de volatilité (ratio de Sharpe ${optimization.sharpe}, taux sans risque ${optimization.riskFreePct} %).`);
      if (target != null) summary.push(optimization.reachedTarget ? `Objectif de rendement de ${optimization.targetYieldPct} % atteint avec le portefeuille le moins risqué possible sous vos contraintes.` : `Objectif de ${optimization.targetYieldPct} % non atteignable sous vos contraintes : maximum ${optimization.maxAchievablePct} %. Relâchez le poids maximal, le nombre de lignes ou l'horizon.`);
      if (target != null && !optimization.reachedTarget) warnings.push(`Rendement visé ${optimization.targetYieldPct} % hors de portée dans les conditions actuelles (maximum ${optimization.maxAchievablePct} %).`);
    } else {
      summary.push("Allocation heuristique par score Kraken (univers trop restreint pour l'optimiseur).");
    }
    if (forecastsOut.length) {
      const avgHit = forecastsOut.reduce((a, f) => a + f.hitRate3M, 0) / forecastsOut.length;
      summary.push(`Prévisions à 3 mois : précision directionnelle historique moyenne ${r0(avgHit * 100)} % sur les valeurs retenues ; les intervalles à 90 % sont indiqués ligne par ligne.`);
    }

    return {
      generatedAt: Date.now(),
      style: profile.style,
      capital: input.capital,
      investable: r0(invested),
      cashReserve: r0(cashReserve),
      cashReservePct: r1(input.capital ? (cashReserve / input.capital) * 100 : 0),
      allocation,
      sectorBreakdown,
      metrics: {
        lines: allocation.length,
        expectedDividendYieldPct: r1(divYield),
        expectedReturnPct: r1(expectedReturn),
        annualizedReturnPct: r1(annualized),
        estimatedVolatilityPct: r0(vol * 100),
        maxLineWeightPct: r1(maxLine),
        annualDividendIncome: r0((invested * divYield) / 100),
      },
      scenarios,
      existing,
      newsContext: { marketSentiment: market.score, marketCount: market.count, headlines: market.headlines },
      optimization,
      forecasts: forecastsOut,
      bonds: {
        targetSharePct: targetBondShare,
        sharePct: r1(bondShare),
        amount: r0(bondAmount),
        lines: bondLines,
        annualCoupons: r0(bondLines.reduce((a, l) => a + l.annualCoupon, 0)),
        avgYieldPct: r2(bondYield),
        avgDurationYears: r2(bondDuration),
        rationale: bondLines.length
          ? [`Part obligataire ${input.bondSharePct != null ? "demandée" : "recommandée pour votre profil"} : ${targetBondShare} % du capital.`, "Sélection par rendement actuariel corrigé du risque émetteur, échéances compatibles avec l'horizon, au plus 40 % par émetteur.", "Les obligations stabilisent le portefeuille (revenu fixe, remboursement du capital) ; leur cours varie avec les taux (duration)."]
          : [],
      },
      summary,
      warnings,
    };
  }

  /** Enregistre une demande et son rapport généré. */
  create(userId: number, requesterType: RequesterType, sgiCode: string | null, input: AdvisoryInput): AdvisoryView {
    if (requesterType === "sgi") {
      if (!sgiCode || !SGI_MAP.has(sgiCode)) throw new Error("SGI inconnue");
      if (!input.clientLabel?.trim()) throw new Error("Indiquez le client ou le portefeuille concerné");
    }
    const report = this.generateReport(input);
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO advisory_requests(user_id, requester_type, sgi_code, client_label, capital, objective, horizon_months, risk_tolerance, preferred_sectors, constraints, holdings, status, report, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'generated',?,?,?)`,
      )
      .run(userId, requesterType, sgiCode, input.clientLabel?.trim() ?? null, input.capital, input.objective, input.horizonMonths, input.riskTolerance, JSON.stringify(input.preferredSectors ?? []), input.constraints ?? null, JSON.stringify(input.holdings ?? []), JSON.stringify(report), now, now);
    const view = this.get(Number(info.lastInsertRowid))!;
    this.emit("created", view);
    return view;
  }

  get(id: number): AdvisoryView | undefined {
    const row = this.db
      .prepare("SELECT a.*, u.full_name AS requester_name, u.email AS requester_email FROM advisory_requests a JOIN users u ON u.id = a.user_id WHERE a.id = ?")
      .get(id) as AdvisoryRequest | undefined;
    return row ? toView(row) : undefined;
  }

  listForUser(userId: number): AdvisoryView[] {
    return (this.db.prepare("SELECT * FROM advisory_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(userId) as AdvisoryRequest[]).map(toView);
  }

  /** Demandes d'une SGI (tous ses collaborateurs). */
  listForSgi(sgiCode: string): AdvisoryView[] {
    return (this.db.prepare("SELECT * FROM advisory_requests WHERE sgi_code = ? ORDER BY created_at DESC LIMIT 200").all(sgiCode) as AdvisoryRequest[]).map(toView);
  }

  /** File des analystes : toutes les demandes, les non validées d'abord. */
  inbox(): AdvisoryView[] {
    return (
      this.db
        .prepare(
          `SELECT a.*, u.full_name AS requester_name, u.email AS requester_email FROM advisory_requests a JOIN users u ON u.id = a.user_id
           ORDER BY CASE a.status WHEN 'generated' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 300`,
        )
        .all() as AdvisoryRequest[]
    ).map(toView);
  }

  review(analystId: number, id: number, decision: "validated" | "declined", note?: string): AdvisoryView {
    const existing = this.get(id);
    if (!existing) throw new Error("Demande introuvable");
    this.db
      .prepare("UPDATE advisory_requests SET status = ?, analyst_id = ?, analyst_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
      .run(decision, analystId, note ?? null, Date.now(), Date.now(), id);
    const view = this.get(id)!;
    this.emit("reviewed", view);
    return view;
  }

  /** Régénère le rapport d'une demande (marché ayant évolué) ; repasse en « generated ». */
  regenerate(id: number, userId: number | null): AdvisoryView {
    const existing = this.get(id);
    if (!existing || (userId !== null && existing.user_id !== userId)) throw new Error("Demande introuvable");
    const report = this.generateReport({
      capital: existing.capital,
      objective: existing.objective as DeclaredProfile["objective"],
      horizonMonths: existing.horizon_months,
      riskTolerance: existing.risk_tolerance,
      preferredSectors: existing.preferred_sectors,
      constraints: existing.constraints ?? undefined,
      holdings: existing.holdings,
      clientLabel: existing.client_label ?? undefined,
    });
    this.db.prepare("UPDATE advisory_requests SET report = ?, status = 'generated', analyst_id = NULL, analyst_note = NULL, reviewed_at = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(report), Date.now(), id);
    return this.get(id)!;
  }

  stats() {
    const rows = this.db.prepare("SELECT status, requester_type, COUNT(*) AS n, COALESCE(SUM(capital),0) AS capital FROM advisory_requests GROUP BY status, requester_type").all() as { status: AdvisoryStatus; requester_type: RequesterType; n: number; capital: number }[];
    return rows;
  }
}

function toView(row: AdvisoryRequest): AdvisoryView {
  return { ...row, report: JSON.parse(row.report) as AdvisoryReport, preferred_sectors: JSON.parse(row.preferred_sectors || "[]"), holdings: JSON.parse(row.holdings || "[]") };
}

export type { Recommendation };
