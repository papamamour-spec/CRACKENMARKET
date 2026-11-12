import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { INSTRUMENTS } from "../data/instruments.js";
import { DEFAULT_EVALUATION, evaluationDates, finalizeReport, observeAt, walkForwardEvaluation, type EvaluationConfig, type EvaluationReport, type Observation } from "../engine/evaluation.js";
import type { Candle } from "../engine/indicators.js";
import type { MarketService } from "./market.js";

export interface StoredReport {
  id: number;
  createdAt: number;
  report: EvaluationReport;
}

export interface EvaluationStatus {
  running: { startedAt: number; done: number; total: number; config: EvaluationConfig } | null;
  latestAt: number | null;
  reports: number;
}

export interface ReportSummary {
  id: number;
  createdAt: number;
  config: EvaluationConfig;
  universe: number;
  horizons: { horizon: string; n: number; hitRate: number; baselineHitRate: number; skill: number; ic: number | null; icT: number | null; coverage90: number; topKPct: number; equalWeightPct: number; indexPct: number | null }[];
}

/**
 * Service d'évaluation : exécute le backtest en marche avant par lots (une date par tour, pour ne
 * pas bloquer l'API), conserve chaque rapport (reproductible : même configuration, même graine,
 * mêmes données → même rapport) et expose le dernier.
 */
export class EvaluationService extends EventEmitter {
  private running: EvaluationStatus["running"] = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: DB, private readonly market: MarketService) {
    super();
  }

  private universe(): { candlesBySymbol: Map<string, Candle[]>; indexByTs: Map<number, number> } {
    const candlesBySymbol = new Map<string, Candle[]>();
    for (const inst of INSTRUMENTS) {
      const c = this.market.history(inst.symbol, 5000);
      if (c.length) candlesBySymbol.set(inst.symbol, c);
    }
    const indexByTs = new Map(this.market.indexHistory(5000).map((p) => [p.ts, p.composite]));
    return { candlesBySymbol, indexByTs };
  }

  /** Évaluation synchrone (script, tests). */
  runSync(config: Partial<EvaluationConfig> = {}, onProgress?: (done: number, total: number) => void): EvaluationReport {
    const u = this.universe();
    const report = walkForwardEvaluation({ ...u, config, onProgress });
    this.store(report);
    return report;
  }

  /** Lance l'évaluation en tâche de fond ; renvoie false si une exécution est déjà en cours. */
  run(partial: Partial<EvaluationConfig> = {}): boolean {
    if (this.running) return false;
    const config: EvaluationConfig = { ...DEFAULT_EVALUATION, ...partial };
    const u = this.universe();
    const dates = evaluationDates(u.candlesBySymbol, config);
    this.running = { startedAt: Date.now(), done: 0, total: dates.length, config };
    const obs: Observation[] = [];
    const queue = [...dates];
    const step = () => {
      const ts = queue.shift();
      if (ts == null) {
        try {
          const report = finalizeReport(obs, u.indexByTs, config, u.candlesBySymbol.size);
          this.store(report);
          this.emit("report", report);
        } catch (e) {
          console.warn(`[evaluation] ${(e as Error).message}`);
        }
        this.running = null;
        this.timer = null;
        return;
      }
      try {
        for (const [symbol, candles] of u.candlesBySymbol) obs.push(...observeAt(symbol, candles, u.indexByTs, ts, config));
      } catch (e) {
        console.warn(`[evaluation] date ${new Date(ts).toISOString().slice(0, 10)} : ${(e as Error).message}`);
      }
      this.running!.done++;
      this.timer = setTimeout(step, 30);
    };
    this.timer = setTimeout(step, 10);
    return true;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = null;
  }

  private store(report: EvaluationReport): number {
    return Number(this.db.prepare("INSERT INTO evaluation_reports(created_at, config, report) VALUES (?,?,?)").run(report.generatedAt, JSON.stringify(report.config), JSON.stringify(report)).lastInsertRowid);
  }

  latest(): StoredReport | null {
    const r = this.db.prepare("SELECT id, created_at, report FROM evaluation_reports ORDER BY id DESC LIMIT 1").get() as { id: number; created_at: number; report: string } | undefined;
    return r ? { id: r.id, createdAt: r.created_at, report: JSON.parse(r.report) as EvaluationReport } : null;
  }

  get(id: number): StoredReport | null {
    const r = this.db.prepare("SELECT id, created_at, report FROM evaluation_reports WHERE id = ?").get(id) as { id: number; created_at: number; report: string } | undefined;
    return r ? { id: r.id, createdAt: r.created_at, report: JSON.parse(r.report) as EvaluationReport } : null;
  }

  /** Rapports passés, résumés : permet de suivre si une version du modèle fait mieux que la précédente. */
  history(limit = 20): ReportSummary[] {
    const rows = this.db.prepare("SELECT id, created_at, report FROM evaluation_reports ORDER BY id DESC LIMIT ?").all(limit) as { id: number; created_at: number; report: string }[];
    return rows.map((r) => {
      const rep = JSON.parse(r.report) as EvaluationReport;
      return {
        id: r.id,
        createdAt: r.created_at,
        config: rep.config,
        universe: rep.universe,
        horizons: rep.horizons.map((h) => ({ horizon: h.horizon, n: h.n, hitRate: h.hitRate, baselineHitRate: h.baselineHitRate, skill: h.skill, ic: h.ic.mean, icT: h.ic.tStat, coverage90: h.coverage90, topKPct: h.strategy.topK.totalReturnPct, equalWeightPct: h.strategy.equalWeight.totalReturnPct, indexPct: h.strategy.index?.totalReturnPct ?? null })),
      };
    });
  }

  status(): EvaluationStatus {
    const agg = this.db.prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM evaluation_reports").get() as { n: number; last: number | null };
    return { running: this.running, latestAt: agg.last, reports: agg.n };
  }
}
