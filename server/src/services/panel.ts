import { EventEmitter } from "node:events";
import { INSTRUMENTS } from "../data/instruments.js";
import { panelModel, type ExtrasAt, type PanelHorizonStats, type PanelPrediction, type PanelResult } from "../engine/panel.js";
import type { Horizon } from "../engine/forecast.js";
import type { Candle } from "../engine/indicators.js";
import type { MarketService } from "./market.js";
import type { CorporateService } from "./corporate.js";
import type { FundamentalsService } from "./fundamentals.js";

const TTL_MS = 6 * 3600_000;
const DAY = 86_400_000;

export interface PanelSummary {
  asOf: number | null;
  computedAt: number | null;
  symbols: number;
  stats: PanelHorizonStats[];
  /** classement des rendements relatifs attendus à 1 mois */
  ranking: { symbol: string; name: string; relPct: number; top: string | null }[];
}

/**
 * Service du modèle de panel : entraîne la régression commune sur l'historique ajusté de toute la
 * cote (toutes les 6 heures et à chaque changement de dividendes ou de fondamentaux), fournit à
 * chaque valeur son rendement relatif attendu par horizon pour l'ensemble de prévision, et expose
 * `extrasAt` (rendement du dividende, rendement bénéficiaire, détachement proche connus à une date)
 * pour l'évaluation en marche avant.
 */
export class PanelService extends EventEmitter {
  private result: PanelResult | null = null;
  private computedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private corporate: CorporateService | null = null;
  private fundamentals: FundamentalsService | null = null;

  constructor(private readonly market: MarketService) {
    super();
  }

  attach(corporate: CorporateService | null, fundamentals: FundamentalsService | null): void {
    this.corporate = corporate;
    this.fundamentals = fundamentals;
    corporate?.on("change", () => { this.computedAt = 0; });
    fundamentals?.on("change", () => { this.computedAt = 0; });
  }

  start(): void {
    setTimeout(() => this.ensure(), 5_000);
    this.timer = setInterval(() => this.ensure(), 30 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Variables de fondamentaux connues à une date (aucune donnée postérieure). */
  readonly extrasAt: ExtrasAt = (symbol, ts, price) => {
    let dividendYieldPct: number | null = null;
    let daysToExDividend: number | null = null;
    if (this.corporate) {
      const divs = this.corporate.dividends(symbol);
      const known = divs.filter((d) => d.exDate != null && d.exDate <= ts && d.netEstimated != null).sort((a, b) => b.exDate! - a.exDate!)[0];
      if (known && price > 0) dividendYieldPct = (known.netEstimated! / price) * 100;
      const next = divs.filter((d) => d.exDate != null && d.exDate > ts).sort((a, b) => a.exDate! - b.exDate!)[0];
      if (next) daysToExDividend = Math.round((next.exDate! - ts) / DAY);
    }
    const earningsYieldPct = this.fundamentals?.earningsYieldAt(symbol, ts, price) ?? null;
    return { dividendYieldPct, earningsYieldPct, daysToExDividend };
  };

  private universe(): Map<string, Candle[]> {
    const u = new Map<string, Candle[]>();
    for (const inst of INSTRUMENTS) {
      const c = this.market.history(inst.symbol, 1400);
      if (c.length >= 100) u.set(inst.symbol, c);
    }
    return u;
  }

  /** Recalcule si le modèle est périmé. */
  ensure(): PanelResult | null {
    if (this.result && Date.now() - this.computedAt < TTL_MS) return this.result;
    try {
      this.result = panelModel(this.universe(), null, { extrasAt: this.extrasAt });
      this.computedAt = Date.now();
      this.emit("panel", this.result);
    } catch (e) {
      console.warn(`[panel] ${(e as Error).message}`);
    }
    return this.result;
  }

  /** Prédictions d'une valeur pour l'ensemble de prévision (null si le modèle n'est pas encore calculé). */
  forSymbol(symbol: string): Partial<Record<Horizon, PanelPrediction & { testMaePct: number | null; naiveMaePct: number | null }>> | null {
    const r = this.ensure();
    const p = r?.predictions.get(symbol);
    if (!r || !p) return null;
    const out: Partial<Record<Horizon, PanelPrediction & { testMaePct: number | null; naiveMaePct: number | null }>> = {};
    for (const s of r.stats) {
      const v = p[s.horizon];
      if (v) out[s.horizon] = { ...v, testMaePct: s.testMaePct, naiveMaePct: s.naiveMaePct };
    }
    return out;
  }

  summary(horizon: Horizon = "1M"): PanelSummary {
    const r = this.result;
    const ranking = r
      ? [...r.predictions.entries()]
          .filter(([, p]) => p[horizon])
          .map(([symbol, p]) => {
            const top = [...p[horizon]!.contributions].sort((a, b) => Math.abs(b.contributionPct) - Math.abs(a.contributionPct))[0];
            return { symbol, name: INSTRUMENTS.find((i) => i.symbol === symbol)?.name ?? symbol, relPct: p[horizon]!.relPct, top: top && Math.abs(top.contributionPct) >= 0.1 ? `${top.label} (${top.contributionPct > 0 ? "+" : ""}${top.contributionPct} pt)` : null };
          })
          .sort((a, b) => b.relPct - a.relPct)
      : [];
    return { asOf: r?.asOf ?? null, computedAt: this.computedAt || null, symbols: r?.symbols ?? 0, stats: r?.stats ?? [], ranking };
  }
}
