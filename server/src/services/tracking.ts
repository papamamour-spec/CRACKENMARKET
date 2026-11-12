/**
 * Suivi réel des portefeuilles recommandés.
 *
 * Un portefeuille proposé par le guichet de conseil ou par la cible du portefeuille détenu est figé à sa
 * date (quantités achetées au cours du jour, frais d'entrée déduits) puis valorisé chaque séance sur
 * l'historique ajusté (dividendes et opérations sur le capital inclus) et comparé au BRVM Composite et
 * au BRVM 30, net des frais d'entrée et de sortie. C'est la mesure honnête de ce que valent les conseils.
 */
import type { DB } from "../db/index.js";
import { INSTRUMENT_MAP } from "../data/instruments.js";
import { feeSchedule, oneWayCostRate, tradeCost } from "../engine/costs.js";
import type { MarketService } from "./market.js";

export type TrackedKind = "conseil" | "cible" | "manuel";

export interface TrackedLine { symbol: string; weightPct: number; price: number; quantity: number; amount: number }

export interface TrackedPortfolio {
  id: number;
  kind: TrackedKind;
  label: string;
  createdAt: number;
  startTs: number;
  capital: number;
  cash: number;
  entryCost: number;
  lines: TrackedLine[];
  sourceId: number | null;
}

export interface TrackedStats {
  days: number;
  sessions: number;
  value: number;
  /** net des frais d'entrée (déjà déduits) et de sortie */
  valueNet: number;
  returnPct: number;
  returnNetPct: number;
  compositePct: number;
  brvm30Pct: number;
  alphaCompositePct: number;
  alphaBrvm30Pct: number;
  annualizedPct: number | null;
  maxDrawdownPct: number;
  volatilityPct: number | null;
  /** part des séances où le portefeuille bat l'indice composite */
  beatRate: number | null;
}

export interface TrackedView extends TrackedPortfolio {
  stats: TrackedStats;
  series: { time: number; value: number; portfolioPct: number; benchmarkPct: number; brvm30Pct: number }[];
}

const r0 = (v: number) => Math.round(v);
const r2 = (v: number) => Math.round(v * 100) / 100;

export class TrackingService {
  constructor(private readonly db: DB, private readonly market: MarketService) {}

  create(userId: number, input: { kind: TrackedKind; label: string; capital: number; lines: { symbol: string; weightPct: number }[]; sourceId?: number | null }): TrackedView {
    if (!(input.capital > 0)) throw new Error("Capital invalide");
    const fees = feeSchedule();
    const lines: TrackedLine[] = [];
    let entryCost = 0;
    for (const l of input.lines) {
      const symbol = l.symbol.toUpperCase();
      const inst = INSTRUMENT_MAP.get(symbol);
      if (!inst || !(l.weightPct > 0)) continue;
      const price = this.market.price(symbol) || inst.refPrice;
      const quantity = Math.floor((input.capital * l.weightPct) / 100 / price);
      if (quantity <= 0) continue;
      const amount = quantity * price;
      entryCost += tradeCost(amount, fees);
      lines.push({ symbol, weightPct: r2((amount / input.capital) * 100), price, quantity, amount: r0(amount) });
    }
    if (lines.length < 1) throw new Error("Aucune ligne valorisable");
    const invested = lines.reduce((a, l) => a + l.amount, 0);
    const cash = input.capital - invested - entryCost;
    if (cash < 0) throw new Error("Les frais d'entrée dépassent les liquidités restantes : réduisez légèrement les poids");
    const now = Date.now();
    const startTs = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    const info = this.db.prepare("INSERT INTO recommended_portfolios(user_id, kind, label, created_at, start_ts, capital, lines, cash, entry_cost, source_id) VALUES (?,?,?,?,?,?,?,?,?,?)").run(userId, input.kind, input.label.slice(0, 120), now, startTs, input.capital, JSON.stringify(lines), cash, r0(entryCost), input.sourceId ?? null);
    return this.view(userId, Number(info.lastInsertRowid))!;
  }

  remove(userId: number, id: number): boolean {
    return this.db.prepare("DELETE FROM recommended_portfolios WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  }

  private row(r: Record<string, unknown>): TrackedPortfolio {
    return { id: Number(r.id), kind: r.kind as TrackedKind, label: String(r.label), createdAt: Number(r.created_at), startTs: Number(r.start_ts), capital: Number(r.capital), cash: Number(r.cash), entryCost: Number(r.entry_cost), lines: JSON.parse(String(r.lines)) as TrackedLine[], sourceId: r.source_id == null ? null : Number(r.source_id) };
  }

  list(userId: number): (TrackedPortfolio & { stats: TrackedStats })[] {
    const rows = this.db.prepare("SELECT * FROM recommended_portfolios WHERE user_id = ? ORDER BY created_at DESC").all(userId) as Record<string, unknown>[];
    return rows.map((r) => { const p = this.row(r); return { ...p, stats: this.valuation(p).stats }; });
  }

  view(userId: number, id: number): TrackedView | null {
    const r = this.db.prepare("SELECT * FROM recommended_portfolios WHERE id = ? AND user_id = ?").get(id, userId) as Record<string, unknown> | undefined;
    if (!r) return null;
    const p = this.row(r);
    return { ...p, ...this.valuation(p) };
  }

  /** Valorisation quotidienne depuis le départ : cours ajustés rapportés au cours ajusté du jour de départ (rendement total). */
  valuation(p: TrackedPortfolio): { stats: TrackedStats; series: TrackedView["series"] } {
    const fees = feeSchedule();
    const exit = oneWayCostRate(fees);
    const byDate = new Map<number, number>();
    const datesSet = new Set<number>();
    const perLine: { line: TrackedLine; base: number; closes: Map<number, number> }[] = [];
    for (const line of p.lines) {
      const hist = this.market.history(line.symbol, 5000).filter((c) => c.ts >= p.startTs);
      if (!hist.length) continue;
      const closes = new Map(hist.map((c) => [c.ts, c.close]));
      for (const c of hist) datesSet.add(c.ts);
      perLine.push({ line, base: hist[0].close, closes });
    }
    const dates = [...datesSet].sort((a, b) => a - b);
    const last = new Map<string, number>();
    for (const ts of dates) {
      let v = p.cash;
      for (const x of perLine) {
        const close = x.closes.get(ts) ?? last.get(x.line.symbol) ?? x.base;
        last.set(x.line.symbol, close);
        v += x.line.quantity * x.line.price * (close / x.base);
      }
      byDate.set(ts, v);
    }
    const idx = this.market.indexHistory(5000).filter((x) => x.ts >= p.startTs);
    const idx0 = idx[0];
    const idxByTs = new Map(idx.map((x) => [x.ts, x]));
    let lastIdx = idx0;
    const series: TrackedView["series"] = dates.map((ts) => {
      const value = byDate.get(ts)!;
      const i = idxByTs.get(ts) ?? lastIdx;
      lastIdx = i;
      return { time: ts, value: r0(value), portfolioPct: r2((value / p.capital - 1) * 100), benchmarkPct: idx0 ? r2((i.composite / idx0.composite - 1) * 100) : 0, brvm30Pct: idx0 ? r2((i.brvm30 / idx0.brvm30 - 1) * 100) : 0 };
    });
    const lastPt = series[series.length - 1];
    const value = lastPt?.value ?? p.capital - p.entryCost;
    const investedNow = value - p.cash;
    const valueNet = value - investedNow * exit;
    let peak = -Infinity;
    let maxDd = 0;
    const rets: number[] = [];
    series.forEach((s, k) => {
      peak = Math.max(peak, s.value);
      maxDd = Math.min(maxDd, s.value / peak - 1);
      if (k > 0 && series[k - 1].value > 0) rets.push(Math.log(s.value / series[k - 1].value));
    });
    const days = lastPt ? Math.max(0, Math.round((lastPt.time - p.startTs) / 86_400_000)) : 0;
    const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    const vol = rets.length > 5 ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252) : null;
    const returnPct = (value / p.capital - 1) * 100;
    const returnNetPct = (valueNet / p.capital - 1) * 100;
    const compositePct = lastPt?.benchmarkPct ?? 0;
    const brvm30Pct = lastPt?.brvm30Pct ?? 0;
    const beats = series.filter((s) => s.portfolioPct > s.benchmarkPct).length;
    return {
      stats: {
        days,
        sessions: series.length,
        value: r0(value),
        valueNet: r0(valueNet),
        returnPct: r2(returnPct),
        returnNetPct: r2(returnNetPct),
        compositePct,
        brvm30Pct,
        alphaCompositePct: r2(returnNetPct - compositePct),
        alphaBrvm30Pct: r2(returnNetPct - brvm30Pct),
        annualizedPct: days >= 30 ? r2((Math.pow(valueNet / p.capital, 365 / days) - 1) * 100) : null,
        maxDrawdownPct: r2(maxDd * 100),
        volatilityPct: vol != null ? r2(vol * 100) : null,
        beatRate: series.length >= 5 ? r2(beats / series.length) : null,
      },
      series,
    };
  }
}
