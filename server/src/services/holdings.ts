import type { DB } from "../db/index.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../data/instruments.js";
import { diagnosePortfolio, recommend, type PortfolioDiagnostic, type Recommendation } from "../engine/advisor.js";
import type { BehaviorProfile, PositionRecord } from "../engine/behavior.js";
import { HORIZON_DAYS, type Forecast } from "../engine/forecast.js";
import { optimize, shrinkCovariance } from "../engine/optimizer.js";
import { RISK_FREE_RATE } from "./advisory.js";
import type { AdvisorService } from "./advisor.js";
import type { ForecastService } from "./forecast.js";
import type { MarketService } from "./market.js";
import type { PortfolioService } from "./portfolio.js";
import type { PeriodPerf } from "./market.js";
import { analyzeBond } from "../engine/bonds.js";
import { targetBondSharePct, type BondAllocationLine, type BondService } from "./bonds.js";

export interface HeldPosition {
  symbol: string;
  assetType?: "equity" | "bond";
  quantity: number;
  avgPrice: number | null;
  acquiredAt: number | null;
  note: string | null;
}

export interface HeldPortfolio {
  label: string | null;
  cash: number;
  positions: HeldPosition[];
  updatedAt: number | null;
}

export type LineAction = "renforcer" | "conserver" | "alléger" | "vendre";

export interface AnalysisLine {
  symbol: string;
  name: string;
  sector: string;
  quantity: number;
  avgPrice: number | null;
  price: number;
  value: number;
  cost: number | null;
  pnl: number | null;
  pnlPct: number | null;
  weightPct: number;
  dividendYield: number;
  annualDividend: number;
  perf: PeriodPerf | null;
  recommendation: { action: Recommendation["action"]; score: number; confidence: number; fitScore: number; targetPrice: number; stopLoss: number; rationale: string[]; warnings: string[] };
  forecast: { expected1M: number; probUp1M: number; expected3M: number; probUp3M: number; p5: number; p95: number; liveHitRate: number | null } | null;
  action: { kind: LineAction; quantity: number; amount: number; reasons: string[] };
}

export interface BondLine {
  code: string;
  name: string;
  issuer: string;
  issuerType: string;
  quantity: number;
  avgPrice: number | null;
  price: number; // pied de coupon, FCFA
  pricePct: number; // % du nominal restant dû (cote BRVM)
  quoteSource: "brvm" | "admin" | "simulation";
  accrued: number;
  value: number; // coupon attaché × quantité
  cost: number | null;
  pnl: number | null;
  weightPct: number;
  couponPct: number;
  ytmPct: number;
  currentYieldPct: number;
  durationYears: number;
  remainingYears: number;
  maturityDate: string;
  outstanding: number;
  nextCoupon: { date: number; amount: number } | null;
  annualCoupon: number;
  taxExempt: boolean;
  perf1M: number | null;
  action: { kind: LineAction; quantity: number; amount: number; reasons: string[] };
}

export interface PortfolioAnalysis {
  generatedAt: number;
  profileStyle: string;
  totals: { invested: number; cost: number | null; pnl: number | null; pnlPct: number | null; cash: number; total: number; cashPct: number; annualDividendIncome: number; dividendYieldPct: number; lines: number; sectors: number; bondsValue: number; annualCouponIncome: number; annualIncome: number };
  lines: AnalysisLine[];
  bondLines: BondLine[];
  assetClasses: { equitiesPct: number; bondsPct: number; cashPct: number };
  bondSleeve: { currentPct: number; targetPct: number; gapAmount: number; avgYieldPct: number | null; durationYears: number | null; suggestions: BondAllocationLine[]; verdict: string };
  incomeCalendar: { date: number; code: string; kind: "coupon" | "remboursement"; amount: number }[];
  unknownSymbols: string[];
  diagnostic: PortfolioDiagnostic;
  risk: { volatilityPct: number; beta: number | null; maxDrawdown1yPct: number; var95_1mPct: number; var95_1m: number; topWeightPct: number; hhi: number; concentrationLabel: string };
  forecast: { expected1MPct: number; expected3MPct: number; probUp1M: number; probUp3M: number; amount1M: number; amount3M: number };
  performance: { portfolioPct: Partial<Record<keyof PeriodPerf, number | null>>; indexPct: Partial<Record<keyof PeriodPerf, number | null>> };
  target: {
    method: "optimizer" | "heuristic";
    expectedAnnualReturnPct: number;
    volatilityPct: number;
    sharpe: number;
    currentExpectedAnnualReturnPct: number;
    currentSharpe: number;
    trades: { symbol: string; name: string; side: "acheter" | "vendre"; quantity: number; amount: number; fromPct: number; toPct: number }[];
    keep: { symbol: string; weightPct: number }[];
  } | null;
  actions: { priority: number; title: string; detail: string; kind: LineAction | "diversifier" | "liquidités" | "initier" | "obligations" }[];
  summary: string[];
  warnings: string[];
}

const r0 = (v: number) => Math.round(v);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Portefeuille réellement détenu (chez une SGI) saisi par l'utilisateur, et son analyse. */
export class HoldingsService {
  private forecasts: ForecastService | null = null;
  private bonds: BondService | null = null;

  constructor(
    private readonly db: DB,
    private readonly market: MarketService,
    private readonly advisor: AdvisorService,
    private readonly portfolios: PortfolioService,
  ) {}

  attachForecasts(fc: ForecastService): void {
    this.forecasts = fc;
  }

  attachBonds(b: BondService): void {
    this.bonds = b;
  }

  private isBond(symbol: string): boolean {
    return !!this.bonds?.has(symbol);
  }

  private known(symbol: string): boolean {
    return INSTRUMENT_MAP.has(symbol) || this.isBond(symbol);
  }

  get(userId: number): HeldPortfolio {
    const meta = this.db.prepare("SELECT label, cash, updated_at FROM held_portfolios WHERE user_id = ?").get(userId) as { label: string | null; cash: number; updated_at: number } | undefined;
    const rows = this.db.prepare("SELECT symbol, asset_type, quantity, avg_price, acquired_at, note FROM held_positions WHERE user_id = ? ORDER BY asset_type, symbol").all(userId) as { symbol: string; asset_type: "equity" | "bond"; quantity: number; avg_price: number | null; acquired_at: number | null; note: string | null }[];
    return { label: meta?.label ?? null, cash: meta?.cash ?? 0, updatedAt: meta?.updated_at ?? null, positions: rows.map((r) => ({ symbol: r.symbol, assetType: r.asset_type, quantity: r.quantity, avgPrice: r.avg_price, acquiredAt: r.acquired_at, note: r.note })) };
  }

  /** Remplace l'ensemble du portefeuille saisi. */
  replace(userId: number, input: { label?: string | null; cash?: number; positions: HeldPosition[] }): HeldPortfolio {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.prepare("INSERT INTO held_portfolios(user_id, label, cash, updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET label = excluded.label, cash = excluded.cash, updated_at = excluded.updated_at").run(userId, input.label ?? null, Math.max(0, input.cash ?? 0), now);
      this.db.prepare("DELETE FROM held_positions WHERE user_id = ?").run(userId);
      const ins = this.db.prepare("INSERT OR REPLACE INTO held_positions(user_id, symbol, asset_type, quantity, avg_price, acquired_at, note, updated_at) VALUES (?,?,?,?,?,?,?,?)");
      for (const p of input.positions) {
        const symbol = p.symbol.toUpperCase().trim();
        if (!this.known(symbol) || !(p.quantity > 0)) continue;
        ins.run(userId, symbol, this.isBond(symbol) ? "bond" : "equity", Math.round(p.quantity), p.avgPrice && p.avgPrice > 0 ? p.avgPrice : null, p.acquiredAt ?? null, p.note?.slice(0, 200) ?? null, now);
      }
    });
    tx();
    return this.get(userId);
  }

  upsertLine(userId: number, p: HeldPosition): HeldPortfolio {
    const symbol = p.symbol.toUpperCase().trim();
    if (!this.known(symbol)) throw new Error("Valeur inconnue");
    if (!(p.quantity > 0)) throw new Error("Quantité invalide");
    const now = Date.now();
    this.db.prepare("INSERT INTO held_portfolios(user_id, label, cash, updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at").run(userId, null, 0, now);
    this.db.prepare("INSERT OR REPLACE INTO held_positions(user_id, symbol, asset_type, quantity, avg_price, acquired_at, note, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(userId, symbol, this.isBond(symbol) ? "bond" : "equity", Math.round(p.quantity), p.avgPrice && p.avgPrice > 0 ? p.avgPrice : null, p.acquiredAt ?? null, p.note?.slice(0, 200) ?? null, now);
    return this.get(userId);
  }

  removeLine(userId: number, symbol: string): HeldPortfolio {
    this.db.prepare("DELETE FROM held_positions WHERE user_id = ? AND symbol = ?").run(userId, symbol.toUpperCase());
    return this.get(userId);
  }

  setCash(userId: number, cash: number, label?: string | null): HeldPortfolio {
    const now = Date.now();
    this.db.prepare("INSERT INTO held_portfolios(user_id, label, cash, updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET cash = excluded.cash, label = COALESCE(excluded.label, held_portfolios.label), updated_at = excluded.updated_at").run(userId, label ?? null, Math.max(0, cash), now);
    return this.get(userId);
  }

  /**
   * Import texte (relevé SGI copié, CSV) : une ligne par valeur « SYMBOLE ; quantité ; prix de revient »
   * (séparateurs ; , tabulation ou espaces ; le nom de la société est accepté à la place du symbole).
   */
  parseImport(text: string): { positions: HeldPosition[]; rejected: string[] } {
    const positions: HeldPosition[] = [];
    const rejected: string[] = [];
    const byName = new Map(INSTRUMENTS.map((i) => [i.name.toLowerCase(), i.symbol]));
    for (const b of this.bonds?.defs() ?? []) byName.set(b.name.toLowerCase(), b.code);
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^(valeur|symbole|titre|code)/i.test(line)) continue;
      // séparateurs : « ; », tabulation, deux espaces ou plus ; la virgule n'est séparateur que si elle n'est pas décimale
      const parts = line.split(/[;\t]+|\s{2,}|,(?!\d)/).map((x) => x.trim()).filter(Boolean);
      const cells = parts.length >= 2 ? parts : line.split(/\s+/);
      let symbol = cells[0]?.toUpperCase() ?? "";
      if (!this.known(symbol)) {
        const found = byName.get(cells[0]?.toLowerCase() ?? "") ?? [...byName.entries()].find(([n]) => n.includes((cells[0] ?? "").toLowerCase()) && (cells[0] ?? "").length >= 4)?.[1];
        if (found) symbol = found;
      }
      const num = (x?: string) => (x == null ? NaN : Number(x.replace(/\s/g, "").replace(/ /g, "").replace(",", ".")));
      const quantity = num(cells[1]);
      const avgPrice = num(cells[2]);
      if (!this.known(symbol) || !(quantity > 0)) {
        rejected.push(line);
        continue;
      }
      positions.push({ symbol, assetType: this.isBond(symbol) ? "bond" : "equity", quantity: Math.round(quantity), avgPrice: avgPrice > 0 ? avgPrice : null, acquiredAt: null, note: null });
    }
    return { positions, rejected };
  }

  /** Copie du portefeuille virtuel CrackenMarket dans le portefeuille saisi. */
  importVirtual(userId: number): HeldPortfolio {
    const pf = this.portfolios.getForUser(userId);
    const positions = this.portfolios.positions(pf.id).map((p) => ({ symbol: p.symbol, quantity: p.quantity, avgPrice: p.avgPrice, acquiredAt: null, note: "copié du portefeuille virtuel" }));
    return this.replace(userId, { label: "Copie du portefeuille virtuel", cash: pf.cash, positions });
  }

  /** Analyse complète du portefeuille saisi. */
  analyze(userId: number, override?: { positions: HeldPosition[]; cash: number }): PortfolioAnalysis {
    const held = override ?? this.get(userId);
    const profile = this.advisor.behaviorProfile(userId);
    const unknownSymbols = held.positions.filter((p) => !this.known(p.symbol.toUpperCase())).map((p) => p.symbol);
    const riskFree = RISK_FREE_RATE * 100;
    // ---- Obligations détenues ----
    const bondLines: BondLine[] = [];
    const now = Date.now();
    for (const p of held.positions) {
      const code = p.symbol.toUpperCase();
      if (!this.isBond(code) || !(p.quantity > 0)) continue;
      const v = this.bonds!.view(code);
      if (!v) continue;
      const a = analyzeBond(v, v.quote.price, now);
      const dirty = v.quote.price + a.accrued;
      const value = dirty * p.quantity;
      // prix de revient saisi en % du nominal (cote BRVM, ex. 100) ou en FCFA par obligation
      const avgFcfa = p.avgPrice && p.avgPrice > 0 ? (p.avgPrice <= 200 ? (p.avgPrice / 100) * v.nominal : p.avgPrice) : null;
      const lineCost = avgFcfa != null ? avgFcfa * p.quantity : null;
      const hist = this.bonds!.history(code, 30);
      const perf1M = hist.length > 21 ? r1(((hist[hist.length - 1].close - hist[hist.length - 22].close) / hist[hist.length - 22].close) * 100) : null;
      const reasons: string[] = [];
      let kind: LineAction = "conserver";
      let qty = 0;
      if (a.remainingYears < 0.5) reasons.push(`Échéance dans ${Math.round(a.remainingYears * 12)} mois : remboursement du capital restant (${r0(a.outstanding).toLocaleString("fr-FR")} FCFA par titre) à prévoir`);
      else if (a.ytmPct < riskFree - 1.5 && a.remainingYears > 2) {
        kind = "alléger";
        qty = Math.ceil(p.quantity / 2);
        reasons.push(`Rendement actuariel ${a.ytmPct.toFixed(2)} % nettement sous le taux de référence (${riskFree.toFixed(1)} %) : arbitrage vers une émission mieux rémunérée possible`);
      } else reasons.push(`Conserver jusqu'à l'échéance : rendement actuariel ${a.ytmPct.toFixed(2)} %${v.taxExempt ? " exonéré d'impôt" : ""}, duration ${a.modifiedDuration.toFixed(1)}`);
      if (a.nextCoupon) reasons.push(`Prochain coupon le ${new Date(a.nextCoupon.date).toLocaleDateString("fr-FR")} : ${r0(a.nextCoupon.amount * p.quantity).toLocaleString("fr-FR")} FCFA`);
      bondLines.push({
        code,
        name: v.name,
        issuer: v.issuer,
        issuerType: v.issuerType,
        quantity: p.quantity,
        avgPrice: avgFcfa,
        price: v.quote.price,
        pricePct: v.quote.pricePct,
        quoteSource: v.quote.source,
        accrued: r0(a.accrued),
        value: r0(value),
        cost: lineCost != null ? r0(lineCost) : null,
        pnl: lineCost != null ? r0(value - lineCost) : null,
        weightPct: 0,
        couponPct: v.couponPct,
        ytmPct: r2(a.ytmPct),
        currentYieldPct: r2(a.currentYieldPct),
        durationYears: r2(a.modifiedDuration),
        remainingYears: r2(a.remainingYears),
        maturityDate: v.maturityDate,
        outstanding: r0(a.outstanding),
        nextCoupon: a.nextCoupon ? { date: a.nextCoupon.date, amount: r0(a.nextCoupon.amount * p.quantity) } : null,
        annualCoupon: r0(a.annualCoupon * p.quantity),
        taxExempt: v.taxExempt,
        perf1M,
        action: { kind, quantity: qty, amount: r0(qty * dirty), reasons },
      });
    }
    const bondsValue = bondLines.reduce((a, l) => a + l.value, 0);
    const positions: PositionRecord[] = held.positions
      .filter((p) => INSTRUMENT_MAP.has(p.symbol.toUpperCase()) && p.quantity > 0)
      .map((p) => {
        const symbol = p.symbol.toUpperCase();
        const price = this.market.price(symbol) || INSTRUMENT_MAP.get(symbol)!.refPrice;
        return { symbol, quantity: p.quantity, avgPrice: p.avgPrice ?? price, currentPrice: price, sector: INSTRUMENT_MAP.get(symbol)!.sector };
      });
    const cash = Math.max(0, held.cash);
    const ctx = { profile, positions, cash, news: this.advisor.newsContext() };
    const recs = INSTRUMENTS.map((i) => recommend(this.advisor.technical(i.symbol), ctx));
    const recMap = new Map(recs.map((r) => [r.symbol, r]));
    const diagnostic = diagnosePortfolio({ profile, positions, cash }, recMap);
    const invested = positions.reduce((a, p) => a + p.quantity * p.currentPrice, 0);
    const total = invested + bondsValue + cash;
    for (const l of bondLines) l.weightPct = r1(total ? (l.value / total) * 100 : 0);
    const hasCost = held.positions.some((p) => p.avgPrice && p.avgPrice > 0);
    const cost = hasCost ? positions.reduce((a, p) => a + p.quantity * p.avgPrice, 0) : null;
    const fcMap = new Map<string, Forecast>();
    if (this.forecasts) for (const p of positions) {
      try { fcMap.set(p.symbol, this.forecasts.get(p.symbol)); } catch { /* valeur sans historique */ }
    }
    const tol = profile.effectiveRiskTolerance;
    const maxWeight = tol >= 4 ? 30 : 25;

    const lines: AnalysisLine[] = positions.map((p) => {
      const rec = recMap.get(p.symbol)!;
      const inst = INSTRUMENT_MAP.get(p.symbol)!;
      const value = p.quantity * p.currentPrice;
      const w = total ? (value / total) * 100 : 0;
      const origin = held.positions.find((h) => h.symbol.toUpperCase() === p.symbol)!;
      const lineCost = origin.avgPrice && origin.avgPrice > 0 ? p.quantity * origin.avgPrice : null;
      const fc = fcMap.get(p.symbol);
      const f = fc ? { expected1M: fc.horizons[1].expectedReturnPct, probUp1M: fc.horizons[1].probUp, expected3M: fc.horizons[2].expectedReturnPct, probUp3M: fc.horizons[2].probUp, p5: fc.horizons[2].quantiles.p5, p95: fc.horizons[2].quantiles.p95, liveHitRate: fc.horizons[2].learning.liveHitRate } : null;
      // Action concrète par ligne
      const reasons: string[] = [];
      let kind: LineAction = "conserver";
      let qty = 0;
      if (rec.action === "VENTE" || rec.action === "ÉVITER") {
        kind = "vendre";
        qty = p.quantity;
        reasons.push(rec.rationale[0] ?? "Signal technique négatif");
      } else if (w > maxWeight) {
        kind = "alléger";
        qty = Math.ceil(((w - maxWeight) / 100) * total / p.currentPrice);
        reasons.push(`Poids ${r1(w)} % supérieur au plafond de ${maxWeight} % par ligne pour votre profil`);
      } else if (rec.action === "ALLÉGER") {
        kind = "alléger";
        qty = Math.ceil(p.quantity * 0.3);
        reasons.push(rec.rationale[0] ?? "Momentum défavorable");
      } else if ((rec.action === "ACHAT FORT" || rec.action === "ACHAT") && w < maxWeight * 0.6 && cash > p.currentPrice) {
        kind = "renforcer";
        const budget = Math.min(cash * 0.5, ((maxWeight * 0.6 - w) / 100) * total);
        qty = Math.floor(budget / p.currentPrice);
        if (qty > 0) reasons.push(rec.rationale[0] ?? "Signal favorable");
        else kind = "conserver";
      }
      if (f && kind === "conserver" && f.expected3M <= -5 && f.probUp3M < 0.4) {
        kind = "alléger";
        qty = Math.ceil(p.quantity * 0.25);
        reasons.push(`Prévision 3 mois défavorable (${f.expected3M} %, hausse à ${Math.round(f.probUp3M * 100)} %)`);
      }
      if (f && kind === "renforcer" && f.expected3M < 0) {
        kind = "conserver";
        qty = 0;
        reasons.length = 0;
        reasons.push("Signal technique favorable mais prévision 3 mois négative : attendre une confirmation");
      }
      if (kind === "conserver" && !reasons.length) reasons.push(rec.action === "CONSERVER" ? (rec.rationale[0] ?? "Tendance neutre") : rec.rationale[0] ?? "Position en ligne avec votre profil");
      if (lineCost != null && kind === "vendre" && value < lineCost) reasons.push("Vente en moins-value : vérifiez l'impact fiscal et la liquidité du titre");
      if (f) reasons.push(`Prévision 1 mois ${f.expected1M > 0 ? "+" : ""}${f.expected1M} % (hausse à ${Math.round(f.probUp1M * 100)} %)`);
      const qSnap = this.market.snapshot(p.symbol);
      return {
        symbol: p.symbol,
        name: inst.name,
        sector: inst.sector,
        quantity: p.quantity,
        avgPrice: origin.avgPrice ?? null,
        price: p.currentPrice,
        value: r0(value),
        cost: lineCost != null ? r0(lineCost) : null,
        pnl: lineCost != null ? r0(value - lineCost) : null,
        pnlPct: lineCost ? r1(((value - lineCost) / lineCost) * 100) : null,
        weightPct: r1(w),
        dividendYield: inst.dividendYield,
        annualDividend: r0((value * inst.dividendYield) / 100),
        perf: qSnap?.perf ?? null,
        recommendation: { action: rec.action, score: rec.score, confidence: rec.confidence, fitScore: rec.fitScore, targetPrice: rec.targetPrice, stopLoss: rec.stopLoss, rationale: rec.rationale.slice(0, 3), warnings: rec.warnings.slice(0, 2) },
        forecast: f,
        action: { kind, quantity: qty, amount: r0(qty * p.currentPrice), reasons: reasons.slice(0, 3) },
      };
    });
    lines.sort((a, b) => b.value - a.value);

    // ---- Risque : covariance réelle, bêta vs BRVM Composite, drawdown 1 an, VaR 95 % à 1 mois ----
    const returnsBy = new Map<string, number[]>();
    for (const p of positions) {
      const closes = this.market.history(p.symbol, 260).map((c) => c.close);
      if (closes.length >= 60) returnsBy.set(p.symbol, closes.slice(1).map((v, k) => Math.log(v / closes[k])));
    }
    for (const l of bondLines) {
      const closes = this.bonds!.history(l.code, 260).map((c) => c.close);
      if (closes.length >= 60) returnsBy.set(l.code, closes.slice(1).map((v, k) => Math.log(v / closes[k])));
    }
    let volatility = 0;
    let beta: number | null = null;
    let maxDd = 0;
    const weights = positions.map((p) => (total ? (p.quantity * p.currentPrice) / total : 0));
    const riskAssets = [...positions.map((p) => ({ symbol: p.symbol, value: p.quantity * p.currentPrice })), ...bondLines.map((l) => ({ symbol: l.code, value: l.value }))];
    const withRet = riskAssets.map((p) => ({ p, w: total ? p.value / total : 0 })).filter((x) => returnsBy.has(x.p.symbol));
    if (withRet.length) {
      const cov = shrinkCovariance(withRet.map((x) => returnsBy.get(x.p.symbol)!));
      let v = 0;
      for (let i = 0; i < withRet.length; i++) for (let j = 0; j < withRet.length; j++) v += withRet[i].w * cov[i][j] * withRet[j].w;
      volatility = Math.sqrt(Math.max(0, v));
      // série de valeur du portefeuille (quantités actuelles) sur 1 an
      const n = Math.min(...withRet.map((x) => returnsBy.get(x.p.symbol)!.length));
      const pr: number[] = new Array(n).fill(0);
      for (const x of withRet) {
        const r = returnsBy.get(x.p.symbol)!.slice(-n);
        const wi = x.w / Math.max(1e-9, withRet.reduce((a, y) => a + y.w, 0));
        for (let t = 0; t < n; t++) pr[t] += wi * r[t];
      }
      const idx = this.market.indexHistory(n + 1).map((x) => x.composite);
      if (idx.length === n + 1) {
        const ir = idx.slice(1).map((v2, k) => Math.log(v2 / idx[k]));
        const mi = ir.reduce((a, b) => a + b, 0) / n;
        const mp = pr.reduce((a, b) => a + b, 0) / n;
        let cv = 0;
        let vi = 0;
        for (let t = 0; t < n; t++) { cv += (pr[t] - mp) * (ir[t] - mi); vi += (ir[t] - mi) ** 2; }
        beta = vi > 0 ? r2(cv / vi) : null;
      }
      let peak = 0;
      let cum = 0;
      for (const r of pr) { cum += r; peak = Math.max(peak, cum); maxDd = Math.min(maxDd, cum - peak); }
    }
    const investedShare = total ? (invested + bondsValue) / total : 0;
    const var95 = 1.645 * volatility * Math.sqrt(HORIZON_DAYS["1M"] / 252);
    const hhi = [...weights, ...bondLines.map((l) => l.weightPct / 100)].reduce((a, w) => a + w * w, 0);
    const topWeight = Math.max(0, ...lines.map((l) => l.weightPct));
    const concentrationLabel = hhi > 0.3 ? "très concentré" : hhi > 0.18 ? "concentré" : hhi > 0.1 ? "modérément diversifié" : "bien diversifié";

    // ---- Prévision agrégée ----
    const fw = (h: 1 | 2) => lines.reduce((a, l) => a + (l.forecast ? (h === 1 ? l.forecast.expected1M : l.forecast.expected3M) * (l.value / Math.max(1, invested)) : 0), 0);
    const e1 = fw(1);
    const e3 = fw(2);
    const phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
    const s1 = Math.max(1e-6, volatility * Math.sqrt(21 / 252) * 100);
    const s3 = Math.max(1e-6, volatility * Math.sqrt(63 / 252) * 100);

    // ---- Performance passée vs indice ----
    const periods: (keyof PeriodPerf)[] = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y"];
    const portfolioPct: Partial<Record<keyof PeriodPerf, number | null>> = {};
    const indexPct: Partial<Record<keyof PeriodPerf, number | null>> = {};
    const idxHist = this.market.indexHistory(300);
    const lookback: Record<string, number> = { "1D": 1, "1W": 5, "1M": 21, "3M": 63, "6M": 126, "1Y": 252 };
    const idxPerf = (per: keyof PeriodPerf): number | null => {
      if (idxHist.length < 2) return null;
      const last = idxHist[idxHist.length - 1];
      let base: { composite: number } | undefined;
      if (per === "YTD") {
        const y = new Date(last.ts).getUTCFullYear();
        base = [...idxHist].reverse().find((x) => new Date(x.ts).getUTCFullYear() < y);
      } else {
        const k = lookback[per];
        base = k != null && idxHist.length > k ? idxHist[idxHist.length - 1 - k] : undefined;
      }
      return base && base.composite > 0 ? r1(((last.composite - base.composite) / base.composite) * 100) : null;
    };
    const bondPerf = (code: string, per: keyof PeriodPerf): number | null => {
      const h = this.bonds!.history(code, 300);
      if (h.length < 2) return null;
      const last = h[h.length - 1];
      let base: { close: number } | undefined;
      if (per === "YTD") {
        const y = new Date(last.ts).getUTCFullYear();
        base = [...h].reverse().find((x) => new Date(x.ts).getUTCFullYear() < y);
      } else {
        const k = lookback[per];
        base = k != null && h.length > k ? h[h.length - 1 - k] : undefined;
      }
      return base && base.close > 0 ? ((last.close - base.close) / base.close) * 100 : null;
    };
    for (const per of periods) {
      let num = 0;
      let den = 0;
      for (const l of lines) {
        const v = l.perf?.[per];
        if (v == null) continue;
        num += v * l.value;
        den += l.value;
      }
      for (const l of bondLines) {
        const v = bondPerf(l.code, per);
        if (v == null) continue;
        num += v * l.value;
        den += l.value;
      }
      portfolioPct[per] = den ? r1(num / den) : null;
      indexPct[per] = idxPerf(per);
    }

    // ---- Poche obligataire : part actuelle, cible selon le profil, suggestions ----
    const bondsPct = total ? (bondsValue / total) * 100 : 0;
    const targetBondPct = targetBondSharePct(profile.effectiveRiskTolerance, profile.declared.objective, profile.declared.horizonMonths);
    const gapAmount = r0(((targetBondPct - bondsPct) / 100) * total);
    const bondSuggestions = this.bonds && gapAmount > 50_000 ? this.bonds.suggest(Math.min(gapAmount, cash), profile.declared.horizonMonths, 3, bondLines.map((l) => l.code), profile.effectiveRiskTolerance) : [];
    const avgYield = bondsValue ? bondLines.reduce((a, l) => a + l.ytmPct * l.value, 0) / bondsValue : null;
    const avgDuration = bondsValue ? bondLines.reduce((a, l) => a + l.durationYears * l.value, 0) / bondsValue : null;
    const bondVerdict = !total
      ? ""
      : bondsPct < targetBondPct - 10
        ? `Poche obligataire ${r0(bondsPct)} % contre ${targetBondPct} % recommandés pour votre profil : ${gapAmount.toLocaleString("fr-FR")} FCFA à placer en obligations${cash < gapAmount ? " (liquidités insuffisantes : procéder par étapes)" : ""}.`
        : bondsPct > targetBondPct + 15
          ? `Poche obligataire ${r0(bondsPct)} % au-dessus des ${targetBondPct} % recommandés : un portefeuille plus dynamique est possible pour votre profil.`
          : `Poche obligataire ${r0(bondsPct)} % en ligne avec les ${targetBondPct} % recommandés pour votre profil.`;
    const incomeCalendar: PortfolioAnalysis["incomeCalendar"] = [];
    const horizon12 = now + 365 * 86_400_000;
    for (const l of bondLines) {
      const v = this.bonds!.view(l.code)!;
      for (const f of analyzeBond(v, v.quote.price, now).flows) {
        if (f.date > horizon12) break;
        if (f.coupon > 0) incomeCalendar.push({ date: f.date, code: l.code, kind: "coupon", amount: r0(f.coupon * l.quantity) });
        if (f.principal > 0) incomeCalendar.push({ date: f.date, code: l.code, kind: "remboursement", amount: r0(f.principal * l.quantity) });
      }
    }
    incomeCalendar.sort((a, b) => a.date - b.date);

    // ---- Allocation cible (optimiseur) et transactions de rééquilibrage ----
    let target: PortfolioAnalysis["target"] = null;
    try {
      const universe = recs.filter((r) => (r.action !== "VENTE" && r.action !== "ÉVITER" && r.fitScore >= 30) || positions.some((p) => p.symbol === r.symbol));
      const retAll = new Map<string, number[]>();
      for (const r of universe) {
        const closes = this.market.history(r.symbol, 300).map((c) => c.close);
        if (closes.length >= 60) retAll.set(r.symbol, closes.slice(1).map((v, k) => Math.log(v / closes[k])));
      }
      const expectedAnnual = (r: Recommendation) => {
        const fc = fcMap.get(r.symbol) ?? (this.forecasts ? safe(() => this.forecasts!.get(r.symbol)) : null);
        const techPrice = ((r.targetPrice - r.price) / r.price) * (12 / Math.max(6, profile.declared.horizonMonths));
        let price = techPrice;
        if (fc) {
          const h3 = fc.horizons[2];
          const fcAnnual = Math.max(-0.4, Math.min(0.4, (h3.expectedReturnPct / 100) * 4));
          const w = 0.4 + 0.4 * h3.confidence;
          price = fcAnnual * w + techPrice * (1 - w);
        }
        return Math.max(-0.4, Math.min(0.4, price)) + r.dividendYield / 100;
      };
      // prime de détention : vendre puis racheter coûte frais de courtage et fiscalité (≈ 3 pts annuels), la cible favorise donc ce qui est déjà en portefeuille
      const HOLD_BONUS = 0.03;
      const assets = universe.map((r) => ({ symbol: r.symbol, sector: r.sector, expectedReturn: expectedAnnual(r) + (positions.some((p) => p.symbol === r.symbol) ? HOLD_BONUS : 0), dividendYield: r.dividendYield / 100, price: r.price }));
      const cashReserve = tol >= 4 ? 0.1 : tol >= 3 ? 0.15 : 0.3;
      // la poche actions cible = tout sauf la réserve de liquidités et la poche obligataire recommandée
      const equityShare = Math.max(0.1, 1 - cashReserve - targetBondPct / 100);
      const opt = optimize(assets, retAll, { maxWeight: maxWeight / 100, maxSectorWeight: tol >= 4 ? 0.6 : 0.45, maxLines: tol >= 4 ? 6 : 8, investedMax: equityShare }, null, RISK_FREE_RATE);
      if (opt.feasible && opt.weights.length >= 2 && total > 0) {
        const muOf = new Map(assets.map((a) => [a.symbol, a.expectedReturn]));
        const curRet = positions.reduce((a, p, i) => a + weights[i] * ((muOf.get(p.symbol) ?? 0) - HOLD_BONUS), 0) + (1 - investedShare) * RISK_FREE_RATE;
        const trades: NonNullable<PortfolioAnalysis["target"]>["trades"] = [];
        const targetW = new Map(opt.weights.map((w) => [w.symbol, w.weight]));
        const symbols = new Set([...targetW.keys(), ...positions.map((p) => p.symbol)]);
        for (const sym of symbols) {
          const price = this.market.price(sym) || INSTRUMENT_MAP.get(sym)!.refPrice;
          const cur = positions.find((p) => p.symbol === sym);
          const fromPct = cur ? ((cur.quantity * price) / total) * 100 : 0;
          const toPct = (targetW.get(sym) ?? 0) * 100;
          const diff = ((toPct - fromPct) / 100) * total;
          const qty = Math.floor(Math.abs(diff) / price);
          if (qty === 0 || Math.abs(toPct - fromPct) < 3) continue; // mouvements < 3 % du portefeuille ignorés (frais)
          trades.push({ symbol: sym, name: INSTRUMENT_MAP.get(sym)!.name, side: diff > 0 ? "acheter" : "vendre", quantity: qty, amount: r0(qty * price), fromPct: r1(fromPct), toPct: r1(toPct) });
        }
        trades.sort((a, b) => (a.side === b.side ? b.amount - a.amount : a.side === "vendre" ? -1 : 1));
        target = {
          method: "optimizer",
          expectedAnnualReturnPct: r1(opt.expectedReturn * 100),
          volatilityPct: r1(opt.volatility * 100),
          sharpe: opt.sharpe,
          currentExpectedAnnualReturnPct: r1(curRet * 100),
          currentSharpe: volatility > 0 ? r2((curRet - RISK_FREE_RATE) / volatility) : 0,
          trades,
          keep: opt.weights.filter((w) => positions.some((p) => p.symbol === w.symbol)).map((w) => ({ symbol: w.symbol, weightPct: r1(w.weight * 100) })),
        };
      }
    } catch {
      target = null;
    }

    // ---- Actions ordonnées, synthèse, avertissements ----
    const actions: PortfolioAnalysis["actions"] = [];
    for (const l of lines) {
      if (l.action.kind === "vendre") actions.push({ priority: 1, kind: "vendre", title: `Vendre ${l.symbol} (${l.quantity} titres, ≈ ${l.action.amount.toLocaleString("fr-FR")} FCFA)`, detail: l.action.reasons.join(" · ") });
      else if (l.action.kind === "alléger" && l.action.quantity > 0) actions.push({ priority: 2, kind: "alléger", title: `Alléger ${l.symbol} de ${l.action.quantity} titres (≈ ${l.action.amount.toLocaleString("fr-FR")} FCFA)`, detail: l.action.reasons.join(" · ") });
    }
    for (const l of lines) if (l.action.kind === "renforcer" && l.action.quantity > 0) actions.push({ priority: 3, kind: "renforcer", title: `Renforcer ${l.symbol} de ${l.action.quantity} titres (≈ ${l.action.amount.toLocaleString("fr-FR")} FCFA)`, detail: l.action.reasons.join(" · ") });
    const ideas = diagnostic.rebalancing.filter((r) => r.action === "initier").slice(0, 3);
    for (const i of ideas) actions.push({ priority: 4, kind: "initier", title: `Initier une ligne ${i.symbol} (${INSTRUMENT_MAP.get(i.symbol)?.name ?? ""})`, detail: i.reason });
    if (lines.length > 0 && lines.length < 5) actions.push({ priority: 4, kind: "diversifier", title: "Diversifier vers 6 à 10 lignes sur au moins 3 secteurs", detail: `${lines.length} ligne(s) sur ${diagnostic.sectorExposure.length} secteur(s) : portefeuille ${concentrationLabel}.` });
    for (const l of bondLines) if (l.action.kind === "alléger" && l.action.quantity > 0) actions.push({ priority: 2, kind: "alléger", title: `Alléger ${l.code} de ${l.action.quantity} titres (≈ ${l.action.amount.toLocaleString("fr-FR")} FCFA)`, detail: l.action.reasons.join(" · ") });
    if (total > 0 && bondsPct < targetBondPct - 10) actions.push({ priority: 3, kind: "obligations", title: `${bondsValue > 0 ? "Renforcer" : "Constituer"} la poche obligataire : ${gapAmount.toLocaleString("fr-FR")} FCFA (cible ${targetBondPct} %)`, detail: bondSuggestions.length ? `Suggestions : ${bondSuggestions.map((b) => `${b.code} (${b.ytmPct.toFixed(2)} %, ${b.maturityDate.slice(0, 4)}) × ${b.quantity}`).join(", ")}.` : "Emprunts d'État UEMOA ou obligations BOAD d'échéance compatible avec votre horizon ; voir la page Obligations." });
    else if (total > 0 && bondsPct > targetBondPct + 15 && tol >= 3) actions.push({ priority: 4, kind: "obligations", title: `Poche obligataire ${r0(bondsPct)} % : au-dessus des ${targetBondPct} % de votre profil`, detail: "Réinvestir progressivement les prochains remboursements et coupons en actions plutôt qu'en nouvelles obligations." });
    const cashPct = total ? (cash / total) * 100 : 0;
    const targetCashPct = (tol >= 4 ? 10 : tol >= 3 ? 15 : 30);
    if (cashPct > targetCashPct + 20 && total > 0) actions.push({ priority: 3, kind: "liquidités", title: `Déployer progressivement ${r0(((cashPct - targetCashPct) / 100) * total).toLocaleString("fr-FR")} FCFA de liquidités`, detail: `${r0(cashPct)} % de liquidités contre ${targetCashPct} % recommandés pour votre profil ; achats échelonnés sur plusieurs semaines.` });
    if (cashPct < 3 && total > 0) actions.push({ priority: 3, kind: "liquidités", title: "Reconstituer une réserve de liquidités", detail: "Moins de 3 % du portefeuille en liquidités : aucune marge pour saisir une opportunité ou absorber un choc." });
    actions.sort((a, b) => a.priority - b.priority);

    const divIncome = lines.reduce((a, l) => a + l.annualDividend, 0);
    const couponIncome = bondLines.reduce((a, l) => a + l.annualCoupon, 0);
    const summary: string[] = [];
    const warnings: string[] = [];
    if (!lines.length && !bondLines.length) summary.push("Aucune ligne reconnue : saisissez vos positions (symbole BRVM ou code d'obligation, quantité, prix de revient) pour obtenir une analyse.");
    else {
      summary.push(`Portefeuille de ${lines.length} action(s)${bondLines.length ? ` et ${bondLines.length} obligation(s)` : ""}, valorisé ${r0(total).toLocaleString("fr-FR")} FCFA : ${r0(total ? (invested / total) * 100 : 0)} % actions, ${r0(bondsPct)} % obligations, ${r0(cashPct)} % liquidités${cost != null ? ` ; plus ou moins-value latente sur les actions ${(invested - cost) >= 0 ? "+" : ""}${r0(invested - cost).toLocaleString("fr-FR")} FCFA (${r1(((invested - cost) / cost) * 100)} %)` : ""}.`);
      if (bondLines.length) summary.push(`Obligations : ${r0(bondsValue).toLocaleString("fr-FR")} FCFA, rendement actuariel moyen ${r2(avgYield ?? 0)} %, duration ${r1(avgDuration ?? 0)} ans, ${r0(couponIncome).toLocaleString("fr-FR")} FCFA de coupons par an${incomeCalendar.some((x) => x.kind === "remboursement") ? `, ${r0(incomeCalendar.filter((x) => x.kind === "remboursement").reduce((a, x) => a + x.amount, 0)).toLocaleString("fr-FR")} FCFA de remboursements dans les 12 mois` : ""}.`);
      if (bondVerdict) summary.push(bondVerdict);
      summary.push(`Santé ${diagnostic.healthScore}/100, diversification ${diagnostic.diversificationScore}/100 (${concentrationLabel}), risque ${diagnostic.riskScore}/100 pour un profil ${profile.style.toLowerCase()} ; volatilité annuelle ${r1(volatility * 100)} %${beta != null ? `, bêta ${beta} vs BRVM Composite` : ""}, perte maximale sur 1 an ${r1(maxDd * 100)} %.`);
      summary.push(`Revenu de dividendes attendu ${r0(divIncome).toLocaleString("fr-FR")} FCFA par an (${r1(invested ? (divIncome / invested) * 100 : 0)} % des titres). Prévision Kraken : ${e1 > 0 ? "+" : ""}${r1(e1)} % à 1 mois, ${e3 > 0 ? "+" : ""}${r1(e3)} % à 3 mois (probabilité de hausse ${Math.round(phi(e3 / s3) * 100)} %).`);
      const sells = lines.filter((l) => l.action.kind === "vendre").length;
      const trims = lines.filter((l) => l.action.kind === "alléger").length;
      const adds = lines.filter((l) => l.action.kind === "renforcer").length;
      summary.push(`Recommandations ligne par ligne : ${sells} vente(s), ${trims} allègement(s), ${adds} renforcement(s), ${lines.length - sells - trims - adds} à conserver.`);
      if (target) summary.push(`Portefeuille cible optimisé : ${target.expectedAnnualReturnPct} % de rendement annuel attendu pour ${target.volatilityPct} % de volatilité (Sharpe ${target.sharpe}) contre ${target.currentExpectedAnnualReturnPct} % et ${r1(volatility * 100)} % aujourd'hui (Sharpe ${target.currentSharpe}) ; ${target.trades.length} transaction(s) pour s'en rapprocher.`);
    }
    if (lines.length && topWeight > maxWeight) warnings.push(`${lines[0].symbol} pèse ${topWeight} % du portefeuille : au-delà de ${maxWeight} %, une seule valeur dicte votre performance.`);
    const issuerExposure = new Map<string, number>();
    for (const l of bondLines) issuerExposure.set(l.issuer, (issuerExposure.get(l.issuer) ?? 0) + l.weightPct);
    for (const [issuer, w] of issuerExposure) if (w > 30) warnings.push(`${issuer} représente ${r0(w)} % du portefeuille : concentration sur un seul émetteur obligataire.`);
    if (diagnostic.riskScore > 65 && tol < 3) warnings.push("Le risque du portefeuille dépasse votre tolérance déclarée.");
    if (var95 * total > 0) warnings.push(`Dans 5 % des cas, la perte sur un mois pourrait dépasser ${r0(var95 * total).toLocaleString("fr-FR")} FCFA (VaR 95 %).`);
    warnings.push(...diagnostic.suggestions);
    if (unknownSymbols.length) warnings.push(`Valeurs non reconnues, ignorées : ${unknownSymbols.join(", ")}.`);

    return {
      generatedAt: Date.now(),
      profileStyle: profile.style,
      totals: { invested: r0(invested), cost: cost != null ? r0(cost) : null, pnl: cost != null ? r0(invested - cost) : null, pnlPct: cost ? r1(((invested - cost) / cost) * 100) : null, cash: r0(cash), total: r0(total), cashPct: r1(cashPct), annualDividendIncome: r0(divIncome), dividendYieldPct: r1(invested ? (divIncome / invested) * 100 : 0), lines: lines.length + bondLines.length, sectors: diagnostic.sectorExposure.length, bondsValue: r0(bondsValue), annualCouponIncome: r0(couponIncome), annualIncome: r0(divIncome + couponIncome) },
      lines,
      bondLines,
      assetClasses: { equitiesPct: r1(total ? (invested / total) * 100 : 0), bondsPct: r1(bondsPct), cashPct: r1(cashPct) },
      bondSleeve: { currentPct: r1(bondsPct), targetPct: targetBondPct, gapAmount, avgYieldPct: avgYield != null ? r2(avgYield) : null, durationYears: avgDuration != null ? r2(avgDuration) : null, suggestions: bondSuggestions, verdict: bondVerdict },
      incomeCalendar,
      unknownSymbols,
      diagnostic,
      risk: { volatilityPct: r1(volatility * 100), beta, maxDrawdown1yPct: r1(maxDd * 100), var95_1mPct: r1(var95 * 100), var95_1m: r0(var95 * total), topWeightPct: topWeight, hhi: r2(hhi), concentrationLabel },
      forecast: { expected1MPct: r1(e1), expected3MPct: r1(e3), probUp1M: r2(phi(e1 / s1)), probUp3M: r2(phi(e3 / s3)), amount1M: r0((invested * e1) / 100), amount3M: r0((invested * e3) / 100) },
      performance: { portfolioPct, indexPct },
      target,
      actions,
      summary,
      warnings,
    };
  }
}

function safe<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

/** Fonction d'erreur (approximation d'Abramowitz-Stegun, précision 1e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}
