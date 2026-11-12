/**
 * Portefeuilles modèles par profil.
 *
 * Quatre portefeuilles de référence — prudent, équilibré, dynamique, revenus — calculés par le guichet
 * de conseil (Black-Litterman, covariance factorielle, limite de perte, liquidité, coûts, poche
 * obligataire) sur un capital nominal, puis tenus comme une gestion modèle : le moteur produit une
 * proposition chaque jour après la clôture, l'analyste la publie (ou non) ; chaque publication est suivie
 * nette de frais contre le BRVM Composite et le BRVM 30 (service de suivi). Le portefeuille détenu peut
 * être rapproché d'un modèle par un plan de rééquilibrage par bandes.
 */
import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { INSTRUMENT_MAP } from "../data/instruments.js";
import { DEFAULT_BANDS, rebalancePlan, type RebalancePlan } from "../engine/rebalance.js";
import type { AdvisoryInput, AdvisoryReport, AdvisoryService } from "./advisory.js";
import type { HoldingsService } from "./holdings.js";
import type { MarketService } from "./market.js";
import type { TrackingService, TrackedStats } from "./tracking.js";
import type { BondService } from "./bonds.js";
import { isTradingDay } from "../data/providers/simulation.js";

export type ModelKey = "prudent" | "equilibre" | "dynamique" | "revenus";

export interface ModelParams {
  key: ModelKey;
  label: string;
  description: string;
  objective: AdvisoryInput["objective"];
  horizonMonths: number;
  riskTolerance: number;
  maxLines: number;
  maxWeightPct: number;
}

export const MODEL_PROFILES: ModelParams[] = [
  { key: "prudent", label: "Prudent", description: "Capital d'abord : forte poche d'emprunts d'État, actions de rendement et de qualité, limite de perte serrée.", objective: "balanced", horizonMonths: 36, riskTolerance: 2, maxLines: 8, maxWeightPct: 20 },
  { key: "equilibre", label: "Équilibré", description: "Revenus et croissance à parts égales, poche obligataire modérée, diversification sectorielle.", objective: "balanced", horizonMonths: 48, riskTolerance: 3, maxLines: 8, maxWeightPct: 25 },
  { key: "dynamique", label: "Dynamique", description: "Croissance du capital sur longue durée, poche obligataire réduite, convictions plus marquées.", objective: "growth", horizonMonths: 60, riskTolerance: 4, maxLines: 7, maxWeightPct: 25 },
  { key: "revenus", label: "Revenus", description: "Flux réguliers : rendement du dividende et coupons, titres liquides, revue trimestrielle.", objective: "income", horizonMonths: 60, riskTolerance: 3, maxLines: 8, maxWeightPct: 20 },
];

export const MODEL_CAPITAL = 10_000_000;

export interface ModelLine { symbol: string; name: string; sector: string; weightPct: number; dividendYield: number; expectedReturnPct: number; rationale: string }
export interface ModelBond { code: string; name: string; issuer: string; weightPct: number; ytmPct: number; durationYears: number; maturityDate: string; taxExempt: boolean }

export interface ModelVersion {
  generatedAt: number;
  capital: number;
  lines: ModelLine[];
  bonds: ModelBond[];
  equityPct: number;
  bondPct: number;
  cashPct: number;
  metrics: { expectedAnnualReturnPct: number; netExpectedAnnualReturnPct: number; volatilityPct: number; sharpe: number; dividendYieldPct: number; cvar95_1mPct: number | null; cvarLimitPct: number | null; riskModel: string; bondYieldPct: number; bondDurationYears: number; method: string };
  summary: string[];
  warnings: string[];
  stress: { key: string; label: string; totalPct: number }[];
}

export interface ModelDrift {
  /** opérations hors bande pour passer de la version publiée à la proposition (sur le capital nominal) */
  trades: RebalancePlan["trades"];
  withinBand: RebalancePlan["withinBand"];
  turnoverPct: number;
  /** écart de rendement attendu net entre proposition et version publiée (points) */
  returnGapPct: number;
}

export interface ModelView {
  key: ModelKey;
  label: string;
  description: string;
  params: ModelParams;
  version: number;
  status: "auto" | "validated";
  note: string | null;
  publishedAt: number | null;
  proposedAt: number | null;
  current: ModelVersion | null;
  proposal: ModelVersion | null;
  drift: ModelDrift | null;
  trackingId: number | null;
  performance: TrackedStats | null;
}

export interface ModelPlan {
  key: ModelKey;
  total: number;
  equityPct: number;
  bondPct: number;
  cashPct: number;
  target: { equityPct: number; bondPct: number; cashPct: number };
  plan: RebalancePlan;
  bondSuggestions: { code: string; name: string; weightPct: number; amount: number }[];
  verdict: string;
}

interface Row { key: string; label: string; params: string; current: string | null; proposal: string | null; published_at: number | null; proposed_at: number | null; version: number; status: string; note: string | null; tracking_id: number | null }

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

export class ModelPortfolioService extends EventEmitter {
  private tracking: TrackingService | null = null;
  private holdings: HoldingsService | null = null;
  private bonds: BondService | null = null;
  private computing = false;
  private lastComputeDay = -1;

  constructor(private readonly db: DB, private readonly market: MarketService, private readonly advisory: AdvisoryService) {
    super();
    const ins = this.db.prepare("INSERT OR IGNORE INTO model_portfolios(key, label, params, version, status) VALUES (?,?,?,0,'auto')");
    for (const p of MODEL_PROFILES) ins.run(p.key, p.label, JSON.stringify(p));
  }

  attach(tracking: TrackingService, holdings: HoldingsService, bonds: BondService | null): void {
    this.tracking = tracking;
    this.holdings = holdings;
    this.bonds = bonds;
  }

  /** Calcul au démarrage (après 2 min) puis chaque jour ouvré après la clôture ; MODELS_AUTO=0 désactive. */
  start(): void {
    if (process.env.MODELS_AUTO === "0") return;
    setTimeout(() => void this.recompute(), 120_000);
    setInterval(() => {
      const now = new Date();
      const day = Math.floor(now.getTime() / 86_400_000);
      if (isTradingDay(now) && now.getUTCHours() >= 16 && this.lastComputeDay !== day) {
        this.lastComputeDay = day;
        void this.recompute();
      }
    }, 10 * 60_000);
  }

  private row(key: string): Row | undefined {
    return this.db.prepare("SELECT * FROM model_portfolios WHERE key = ?").get(key) as Row | undefined;
  }

  private parse<T>(s: string | null): T | null {
    if (!s) return null;
    try { return JSON.parse(s) as T; } catch { return null; }
  }

  /** Version d'un modèle calculée par le guichet de conseil. */
  compute(params: ModelParams): ModelVersion {
    const r: AdvisoryReport = this.advisory.generateReport({ capital: MODEL_CAPITAL, objective: params.objective, horizonMonths: params.horizonMonths, riskTolerance: params.riskTolerance, maxLines: params.maxLines, maxWeightPct: params.maxWeightPct, returnModel: "black_litterman" });
    const lines: ModelLine[] = r.allocation.map((l) => ({ symbol: l.symbol, name: l.name, sector: l.sector, weightPct: r1((l.amount / MODEL_CAPITAL) * 100), dividendYield: l.dividendYield, expectedReturnPct: l.expectedReturnPct, rationale: l.rationale[0] ?? "" })).filter((l) => l.weightPct > 0);
    const bonds: ModelBond[] = r.bonds.lines.map((b) => ({ code: b.code, name: b.name, issuer: b.issuer, weightPct: r1((b.amount / MODEL_CAPITAL) * 100), ytmPct: b.ytmPct, durationYears: b.durationYears, maturityDate: b.maturityDate, taxExempt: b.taxExempt }));
    const equityPct = r1(lines.reduce((a, l) => a + l.weightPct, 0));
    const bondPct = r1(bonds.reduce((a, b) => a + b.weightPct, 0));
    return {
      generatedAt: r.generatedAt,
      capital: MODEL_CAPITAL,
      lines,
      bonds,
      equityPct,
      bondPct,
      cashPct: r1(Math.max(0, 100 - equityPct - bondPct)),
      metrics: {
        expectedAnnualReturnPct: r.optimization.expectedAnnualReturnPct,
        netExpectedAnnualReturnPct: r.optimization.netExpectedAnnualReturnPct,
        volatilityPct: r.optimization.volatilityPct,
        sharpe: r.optimization.sharpe,
        dividendYieldPct: r.metrics.expectedDividendYieldPct,
        cvar95_1mPct: r.risk?.loss.cvar95_1mPct ?? null,
        cvarLimitPct: r.risk?.loss.limitPct ?? null,
        riskModel: r.optimization.riskModel,
        bondYieldPct: r.bonds.avgYieldPct,
        bondDurationYears: r.bonds.avgDurationYears,
        method: r.optimization.method,
      },
      summary: r.summary.slice(0, 4),
      warnings: r.warnings.slice(0, 3),
      stress: (r.risk?.stress ?? []).slice(0, 4).map((s) => ({ key: s.key, label: s.label, totalPct: s.totalPct })),
    };
  }

  /** Nouvelle proposition pour chaque modèle ; un modèle jamais publié est publié automatiquement (statut « auto »). */
  async recompute(): Promise<{ computed: string[]; published: string[]; failed: string[] }> {
    if (this.computing) return { computed: [], published: [], failed: ["calcul déjà en cours"] };
    this.computing = true;
    const computed: string[] = [];
    const published: string[] = [];
    const failed: string[] = [];
    try {
      for (const p of MODEL_PROFILES) {
        try {
          const v = this.compute(p);
          if (v.lines.length < 2) { failed.push(`${p.key} (moins de deux lignes éligibles)`); continue; }
          this.db.prepare("UPDATE model_portfolios SET proposal = ?, proposed_at = ? WHERE key = ?").run(JSON.stringify(v), Date.now(), p.key);
          computed.push(p.key);
          const row = this.row(p.key)!;
          if (!row.current) { this.publish(p.key, null, null, "auto"); published.push(p.key); }
        } catch (e) {
          failed.push(`${p.key} (${(e as Error).message})`);
        }
        await new Promise((res) => setImmediate(res));
      }
    } finally {
      this.computing = false;
    }
    if (computed.length) this.emit("models", computed);
    return { computed, published, failed };
  }

  /** Publie la proposition courante : elle devient la version de référence et son suivi net de frais démarre. */
  publish(key: ModelKey, userId: number | null, note: string | null, status: "auto" | "validated" = "validated"): ModelView {
    const row = this.row(key);
    if (!row) throw new Error("Modèle inconnu");
    const proposal = this.parse<ModelVersion>(row.proposal);
    if (!proposal) throw new Error("Aucune proposition à publier : lancez un calcul");
    const version = row.version + 1;
    let trackingId: number | null = row.tracking_id;
    if (this.tracking) {
      try {
        const owner = userId ?? this.ownerId();
        if (owner != null) trackingId = this.tracking.create(owner, { kind: "modele", label: `Modèle ${row.label} v${version}`, capital: MODEL_CAPITAL, lines: proposal.lines.map((l) => ({ symbol: l.symbol, weightPct: l.weightPct })) }).id;
      } catch (e) {
        console.warn(`[models] suivi non démarré pour ${key} : ${(e as Error).message}`);
      }
    }
    const now = Date.now();
    this.db.prepare("UPDATE model_portfolios SET current = ?, published_at = ?, version = ?, status = ?, note = ?, tracking_id = ? WHERE key = ?").run(row.proposal, now, version, status, note, trackingId, key);
    this.db.prepare("INSERT INTO model_versions(key, version, published_at, by_user, note, snapshot, tracking_id) VALUES (?,?,?,?,?,?,?)").run(key, version, now, userId, note, row.proposal, trackingId);
    this.emit("published", key);
    return this.view(key)!;
  }

  /** Premier compte administrateur (propriétaire des suivis des modèles). */
  private ownerId(): number | null {
    const u = this.db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    return u?.id ?? null;
  }

  private drift(current: ModelVersion | null, proposal: ModelVersion | null): ModelDrift | null {
    if (!current || !proposal) return null;
    const price = (s: string) => this.market.price(s) || INSTRUMENT_MAP.get(s)?.refPrice || 0;
    const plan = rebalancePlan(
      current.lines.map((l) => ({ symbol: l.symbol, weight: l.weightPct / 100, price: price(l.symbol) })),
      proposal.lines.map((l) => ({ symbol: l.symbol, weight: l.weightPct / 100, price: price(l.symbol) })),
      MODEL_CAPITAL,
      DEFAULT_BANDS,
    );
    return { trades: plan.trades, withinBand: plan.withinBand, turnoverPct: plan.turnoverPct, returnGapPct: r1(proposal.metrics.netExpectedAnnualReturnPct - current.metrics.netExpectedAnnualReturnPct) };
  }

  view(key: string): ModelView | null {
    const row = this.row(key);
    if (!row) return null;
    const params = JSON.parse(row.params) as ModelParams;
    const current = this.parse<ModelVersion>(row.current);
    const proposal = this.parse<ModelVersion>(row.proposal);
    let performance: TrackedStats | null = null;
    if (row.tracking_id != null && this.tracking) {
      try { performance = this.tracking.statsById(row.tracking_id); } catch { performance = null; }
    }
    return { key: row.key as ModelKey, label: row.label, description: params.description, params, version: row.version, status: row.status as ModelView["status"], note: row.note, publishedAt: row.published_at, proposedAt: row.proposed_at, current, proposal, drift: this.drift(current, proposal), trackingId: row.tracking_id, performance };
  }

  list(): ModelView[] {
    return MODEL_PROFILES.map((p) => this.view(p.key)!).filter(Boolean);
  }

  versions(key: string): { version: number; publishedAt: number; note: string | null; trackingId: number | null; performance: TrackedStats | null }[] {
    const rows = this.db.prepare("SELECT version, published_at, note, tracking_id FROM model_versions WHERE key = ? ORDER BY version DESC").all(key) as { version: number; published_at: number; note: string | null; tracking_id: number | null }[];
    return rows.map((r) => ({ version: r.version, publishedAt: r.published_at, note: r.note, trackingId: r.tracking_id, performance: r.tracking_id != null && this.tracking ? this.tracking.statsById(r.tracking_id) : null }));
  }

  /** Plan de rééquilibrage par bandes du portefeuille détenu d'un utilisateur vers un modèle. */
  planFor(userId: number, key: ModelKey): ModelPlan {
    const v = this.view(key);
    if (!v?.current) throw new Error("Modèle non publié");
    if (!this.holdings) throw new Error("Portefeuille détenu indisponible");
    const held = this.holdings.get(userId);
    const price = (s: string) => this.market.price(s) || INSTRUMENT_MAP.get(s)?.refPrice || 0;
    const equities = held.positions.filter((p) => INSTRUMENT_MAP.has(p.symbol.toUpperCase()) && p.quantity > 0).map((p) => ({ symbol: p.symbol.toUpperCase(), value: p.quantity * price(p.symbol.toUpperCase()) }));
    let bondsValue = 0;
    for (const p of held.positions) {
      if (INSTRUMENT_MAP.has(p.symbol.toUpperCase()) || !this.bonds?.has(p.symbol.toUpperCase())) continue;
      const bv = this.bonds.view(p.symbol.toUpperCase());
      if (bv) bondsValue += p.quantity * bv.quote.price;
    }
    const cash = Math.max(0, held.cash);
    const equityValue = equities.reduce((a, e) => a + e.value, 0);
    const total = equityValue + bondsValue + cash;
    const plan = rebalancePlan(
      equities.map((e) => ({ symbol: e.symbol, weight: total ? e.value / total : 0, price: price(e.symbol) })),
      v.current.lines.map((l) => ({ symbol: l.symbol, weight: l.weightPct / 100, price: price(l.symbol) })),
      total,
      DEFAULT_BANDS,
    );
    const equityPct = r1(total ? (equityValue / total) * 100 : 0);
    const bondPct = r1(total ? (bondsValue / total) * 100 : 0);
    const cashPct = r1(total ? (cash / total) * 100 : 0);
    const bondGap = v.current.bondPct - bondPct;
    const bondSuggestions = bondGap > 5 ? v.current.bonds.map((b) => ({ code: b.code, name: b.name, weightPct: b.weightPct, amount: Math.round((b.weightPct / 100) * total) })) : [];
    const verdict = total <= 0
      ? "Aucune position saisie : renseignez votre portefeuille détenu pour obtenir un plan."
      : plan.trades.length === 0 && Math.abs(bondGap) <= 5
        ? `Votre portefeuille est dans les bandes du modèle ${v.label} : aucune opération avant la prochaine revue (${new Date(plan.nextReview).toLocaleDateString("fr-FR")}).`
        : `${plan.trades.length} opération(s) sur les actions (≈ ${plan.estimatedCost.toLocaleString("fr-FR")} FCFA de frais, rotation ${plan.turnoverPct} %)${bondGap > 5 ? ` ; poche obligataire à renforcer de ${r1(bondGap)} points` : bondGap < -5 ? ` ; poche obligataire ${r1(-bondGap)} points au-dessus du modèle` : ""}.`;
    return { key, total: Math.round(total), equityPct, bondPct, cashPct, target: { equityPct: v.current.equityPct, bondPct: v.current.bondPct, cashPct: v.current.cashPct }, plan, bondSuggestions, verdict };
  }

  status(): { models: number; published: number; lastProposedAt: number | null; computing: boolean } {
    const rows = this.db.prepare("SELECT current, proposed_at FROM model_portfolios").all() as { current: string | null; proposed_at: number | null }[];
    return { models: rows.length, published: rows.filter((r) => r.current).length, lastProposedAt: rows.reduce<number | null>((a, r) => (r.proposed_at != null && (a == null || r.proposed_at > a) ? r.proposed_at : a), null), computing: this.computing };
  }
}
