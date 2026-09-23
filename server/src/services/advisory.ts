import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../data/instruments.js";
import { SGI_MAP } from "../data/sgi.js";
import { buildBehaviorProfile, type DeclaredProfile, type PositionRecord } from "../engine/behavior.js";
import { diagnosePortfolio, proposeAllocation, recommend, type PortfolioDiagnostic, type Recommendation } from "../engine/advisor.js";
import type { AdvisorService } from "./advisor.js";
import type { MarketService } from "./market.js";
import type { NewsService } from "./news.js";

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

/**
 * Guichet de conseil en investissement : un client ou une SGI (pour le compte d'un de ses
 * clients) décrit un placement à réaliser ; le moteur Kraken produit une proposition
 * d'allocation motivée, chiffrée et scénarisée, qu'un analyste peut ensuite valider ou annoter.
 */
export class AdvisoryService extends EventEmitter {
  private newsService: NewsService | null = null;

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
    const proposal = proposeAllocation(recs, profile, input.capital);
    const tol = profile.effectiveRiskTolerance;
    const market = this.newsService?.marketSentiment() ?? { score: 0, count: 0, headlines: [] };
    // actualité de place défavorable : réserve de liquidités relevée de 5 points
    const cashReservePct = (tol >= 4 ? 10 : tol >= 3 ? 15 : 30) + (market.score <= -0.2 ? 5 : 0);

    const allocation: AllocationLine[] = proposal.map((p) => {
      const rec = recMap.get(p.symbol)!;
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
        rationale: rec.rationale.slice(0, 3),
      };
    });
    const invested = allocation.reduce((a, l) => a + l.amount, 0);
    const cashReserve = input.capital - invested;
    const sectors = new Map<string, number>();
    for (const l of allocation) sectors.set(l.sector, (sectors.get(l.sector) ?? 0) + l.amount);
    const sectorBreakdown = [...sectors.entries()].map(([sector, v]) => ({ sector, weightPct: r1(invested ? (v / invested) * 100 : 0) })).sort((a, b) => b.weightPct - a.weightPct);

    // Métriques pondérées par montant
    const w = (l: AllocationLine) => (invested ? l.amount / invested : 0);
    const divYield = allocation.reduce((a, l) => a + l.dividendYield * w(l), 0);
    const horizonYears = declared.horizonMonths / 12;
    const expectedReturn = allocation.reduce((a, l) => a + l.expectedReturnPct * w(l), 0);
    const annualized = horizonYears > 0 ? (Math.pow(1 + expectedReturn / 100, 1 / horizonYears) - 1) * 100 : expectedReturn;
    const vol = allocation.reduce((a, l) => a + (INSTRUMENT_MAP.get(l.symbol)?.volatility ?? 0.3) * w(l), 0) * 0.8; // diversification ≈ -20 %
    const maxLine = allocation.reduce((a, l) => Math.max(a, l.weightPct), 0);
    const horizonVol = vol * Math.sqrt(Math.max(0.25, horizonYears));
    const central = invested * (1 + expectedReturn / 100) + cashReserve;
    const scenarios = {
      pessimistic: r0(Math.max(invested * 0.4, invested * (1 + expectedReturn / 100 - horizonVol)) + cashReserve),
      central: r0(central),
      optimistic: r0(invested * (1 + expectedReturn / 100 + horizonVol) + cashReserve),
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
    summary.push(`Profil ${profile.style.toLowerCase()} avec un objectif ${objectiveLabel} sur ${declared.horizonMonths} mois : ${allocation.length} valeurs sur ${sectorBreakdown.length} secteur(s), ${r0((invested / input.capital) * 100)} % investis et ${r0(cashReservePct)} % de réserve de liquidités recommandée.`);
    if (allocation.length) summary.push(`Rendement de dividende attendu ${r1(divYield)} % par an (≈ ${r0((invested * divYield) / 100).toLocaleString("fr-FR")} FCFA), performance visée ${r1(expectedReturn)} % sur l'horizon (${r1(annualized)} % annualisé), volatilité estimée ${r0(vol * 100)} %.`);
    const top = allocation[0];
    if (top) summary.push(`Première conviction : ${top.name} (${top.weightPct} %), ${top.rationale[0]?.toLowerCase() ?? "signal favorable"}.`);
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
