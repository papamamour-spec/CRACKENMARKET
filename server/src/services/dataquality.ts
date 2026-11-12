/**
 * Contrôle de qualité des données et rapport de risque quotidien.
 *
 * Une plateforme dont on sait exactement d'où vient chaque chiffre et ce qui a changé depuis la veille
 * vaut plus qu'une prévision brillante mais invérifiable. Chaque jour ouvré après la clôture (et à la
 * demande), dix contrôles passent sur les données : cohérence entre le bulletin officiel et les cours
 * en base, fraîcheur du bulletin et de l'historique réel, variations hors limite, dividendes
 * exceptionnels ou incohérents, référentiel, fondamentaux, obligations, collecteurs. Chaque constat porte
 * une sévérité ; un score global est calculé et l'écart avec le passage précédent (constats nouveaux,
 * constats résolus) est conservé. Le rapport de risque du jour reprend le portefeuille détenu, les
 * modèles et la place, et dit ce qui a changé depuis la veille.
 */
import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../data/instruments.js";
import { isTradingDay } from "../data/providers/simulation.js";
import type { MarketService } from "./market.js";
import type { BocService } from "./boc.js";
import type { CorporateService } from "./corporate.js";
import type { BondService } from "./bonds.js";
import type { FundamentalsService } from "./fundamentals.js";
import type { QualityService } from "./quality.js";
import type { NewsService } from "./news.js";
import type { DocumentService } from "./documents.js";
import type { HistoryService } from "./history.js";
import type { HoldingsService } from "./holdings.js";
import type { ModelPortfolioService } from "./models.js";

export type Severity = "info" | "warning" | "error";

export interface Finding {
  check: string;
  severity: Severity;
  symbol: string | null;
  message: string;
  value: number | null;
  /** empreinte stable pour comparer deux passages */
  key: string;
}

export const CHECK_LABELS: Record<string, string> = {
  coherence_cours: "Cohérence bulletin / cours en base",
  fraicheur_bulletin: "Fraîcheur du bulletin officiel",
  fraicheur_historique: "Fraîcheur de l'historique réel",
  variation_limite: "Variations hors limite et cours invalides",
  dividendes: "Dividendes",
  referentiel: "Référentiel des valeurs",
  fondamentaux: "Fondamentaux",
  obligations: "Obligations",
  collecteurs: "Collecteurs",
  modeles: "Portefeuilles modèles",
};

export interface QualityRun {
  id: number;
  ts: number;
  score: number;
  errors: number;
  warnings: number;
  infos: number;
  checks: { check: string; label: string; count: number; worst: Severity | null }[];
  findings: Finding[];
  changes: { added: Finding[]; resolved: Finding[] };
  durationMs: number;
}

export interface DailyReport {
  date: number;
  ts: number;
  market: { composite: number; compositeChangePct: number; brvm30: number; brvm30ChangePct: number; advancers: number; decliners: number; unchanged: number; provider: string };
  quality: { score: number; errors: number; warnings: number } | null;
  holdings: {
    total: number;
    dayPct: number | null;
    cvar95_1mPct: number;
    cvarLimitPct: number;
    volatilityPct: number;
    beta: number | null;
    worstStress: { label: string; totalPct: number } | null;
    outsideBand: number;
    nextReview: number | null;
    warnings: string[];
  } | null;
  models: { key: string; label: string; version: number; returnNetPct: number | null; alphaCompositePct: number | null; cvar95_1mPct: number | null; driftTrades: number }[];
  changes: string[];
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };
const DAY = 86_400_000;
const r1 = (v: number) => Math.round(v * 10) / 10;

function dayStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Dernière séance close : aujourd'hui après 15 h UTC un jour ouvré, sinon le jour ouvré précédent. */
export function lastClosedSession(now = Date.now()): number {
  const d = new Date(now);
  if (!(isTradingDay(d) && d.getUTCHours() >= 15)) d.setUTCDate(d.getUTCDate() - 1);
  while (!isTradingDay(d)) d.setUTCDate(d.getUTCDate() - 1);
  return dayStart(d.getTime());
}

function tradingDaysBetween(from: number, to: number): number {
  let n = 0;
  const d = new Date(from + DAY);
  while (d.getTime() <= to) {
    if (isTradingDay(d)) n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

export class DataQualityService extends EventEmitter {
  private boc: BocService | null = null;
  private corporate: CorporateService | null = null;
  private bonds: BondService | null = null;
  private fundamentals: FundamentalsService | null = null;
  private quality: QualityService | null = null;
  private news: NewsService | null = null;
  private documents: DocumentService | null = null;
  private history: HistoryService | null = null;
  private holdings: HoldingsService | null = null;
  private models: ModelPortfolioService | null = null;
  private running = false;
  private lastDailyDay = -1;

  constructor(private readonly db: DB, private readonly market: MarketService) {
    super();
  }

  attach(s: { boc?: BocService; corporate?: CorporateService; bonds?: BondService; fundamentals?: FundamentalsService; quality?: QualityService; news?: NewsService; documents?: DocumentService; history?: HistoryService; holdings?: HoldingsService; models?: ModelPortfolioService }): void {
    this.boc = s.boc ?? this.boc;
    this.corporate = s.corporate ?? this.corporate;
    this.bonds = s.bonds ?? this.bonds;
    this.fundamentals = s.fundamentals ?? this.fundamentals;
    this.quality = s.quality ?? this.quality;
    this.news = s.news ?? this.news;
    this.documents = s.documents ?? this.documents;
    this.history = s.history ?? this.history;
    this.holdings = s.holdings ?? this.holdings;
    this.models = s.models ?? this.models;
  }

  /** Contrôles 3 min après le démarrage, puis chaque jour ouvré après 16 h UTC (contrôles puis rapport du jour). QUALITY_AUTO=0 désactive. */
  start(): void {
    if (process.env.QUALITY_AUTO === "0") return;
    setTimeout(() => void this.runAll(), 180_000);
    setInterval(() => {
      const now = new Date();
      const day = Math.floor(now.getTime() / DAY);
      if (isTradingDay(now) && now.getUTCHours() >= 16 && this.lastDailyDay !== day) {
        this.lastDailyDay = day;
        void this.runAll();
      }
    }, 15 * 60_000);
  }

  private async runAll(): Promise<void> {
    try {
      this.runChecks();
      this.dailyReport();
    } catch (e) {
      console.warn(`[quality] passage quotidien : ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ contrôles

  private finding(check: string, severity: Severity, symbol: string | null, message: string, value: number | null = null, keyExtra = ""): Finding {
    return { check, severity, symbol, message, value: value != null ? Math.round(value * 100) / 100 : null, key: `${check}|${symbol ?? ""}|${keyExtra}` };
  }

  private lastRealCandle(symbol: string): { ts: number; source: string } | null {
    const r = this.db.prepare("SELECT ts, source FROM candles WHERE symbol = ? AND source <> 'synthetic' ORDER BY ts DESC LIMIT 1").get(symbol) as { ts: number; source: string } | undefined;
    return r ?? null;
  }

  private checkCoherence(now: number): Finding[] {
    const out: Finding[] = [];
    if (!this.boc) return out;
    for (const inst of INSTRUMENTS) {
      const st = this.boc.latest(inst.symbol);
      if (!st || st.close == null || st.close <= 0 || now - st.ts > 15 * DAY) continue;
      const c = this.db.prepare("SELECT close, source FROM candles WHERE symbol = ? AND ts = ?").get(inst.symbol, st.ts) as { close: number; source: string } | undefined;
      if (!c || !(c.close > 0)) { out.push(this.finding("coherence_cours", "warning", inst.symbol, `Séance du ${new Date(st.ts).toLocaleDateString("fr-FR")} au bulletin mais absente de l'historique en base`, null, "absente")); continue; }
      const diff = Math.abs(c.close / st.close - 1) * 100;
      if (diff > 5) out.push(this.finding("coherence_cours", "error", inst.symbol, `Clôture en base ${c.close} (${c.source}) contre ${st.close} au bulletin : écart ${r1(diff)} %`, diff, "ecart"));
      else if (diff > 1) out.push(this.finding("coherence_cours", "warning", inst.symbol, `Clôture en base ${c.close} (${c.source}) contre ${st.close} au bulletin : écart ${r1(diff)} %`, diff, "ecart"));
    }
    return out;
  }

  private checkBulletinFreshness(now: number): Finding[] {
    const out: Finding[] = [];
    if (!this.boc) return out;
    const st = this.boc.status();
    const expected = lastClosedSession(now);
    if (st.lastSession == null) return [this.finding("fraicheur_bulletin", st.auto ? "warning" : "info", null, "Aucun bulletin officiel en base", null, "aucun")];
    const missing = tradingDaysBetween(st.lastSession, expected);
    if (missing >= 3) out.push(this.finding("fraicheur_bulletin", "error", null, `Dernier bulletin du ${new Date(st.lastSession).toLocaleDateString("fr-FR")} : ${missing} séances manquantes`, missing, "retard"));
    else if (missing >= 1) out.push(this.finding("fraicheur_bulletin", "warning", null, `Dernier bulletin du ${new Date(st.lastSession).toLocaleDateString("fr-FR")} : ${missing} séance(s) manquante(s)`, missing, "retard"));
    if (st.lastRun && !st.lastRun.ok && st.lastRun.error && !/rien à collecter/.test(st.lastRun.error)) out.push(this.finding("fraicheur_bulletin", "warning", null, `Dernier passage en échec : ${st.lastRun.error.slice(0, 160)}`, null, "echec"));
    if (st.symbolsLastSession > 0 && st.symbolsLastSession < INSTRUMENTS.length * 0.8) out.push(this.finding("fraicheur_bulletin", "warning", null, `Le dernier bulletin ne couvre que ${st.symbolsLastSession} valeurs sur ${INSTRUMENTS.length}`, st.symbolsLastSession, "couverture"));
    return out;
  }

  private checkHistoryFreshness(now: number): Finding[] {
    const out: Finding[] = [];
    const expected = lastClosedSession(now);
    let noReal = 0;
    for (const inst of INSTRUMENTS) {
      const last = this.lastRealCandle(inst.symbol);
      if (!last) { noReal++; continue; }
      const missing = tradingDaysBetween(last.ts, expected);
      if (missing >= 5) out.push(this.finding("fraicheur_historique", "warning", inst.symbol, `Dernière séance réelle le ${new Date(last.ts).toLocaleDateString("fr-FR")} (${last.source}) : ${missing} séances de retard`, missing, "retard"));
    }
    if (noReal === INSTRUMENTS.length) out.push(this.finding("fraicheur_historique", "warning", null, "Aucune valeur n'a de séance réelle : tout l'historique est synthétique", noReal, "synthetique"));
    else if (noReal > 0) out.push(this.finding("fraicheur_historique", "info", null, `${noReal} valeur(s) sans aucune séance réelle (historique synthétique)`, noReal, "synthetique"));
    if (this.history) {
      const hs = this.history.status();
      if (hs.lastRun && hs.lastRun.failed.length > INSTRUMENTS.length / 2) out.push(this.finding("fraicheur_historique", "error", null, `Collecte de l'historique réel en échec sur ${hs.lastRun.failed.length} valeurs`, hs.lastRun.failed.length, "collecte"));
    }
    return out;
  }

  private checkMoves(): Finding[] {
    const out: Finding[] = [];
    const rows = this.db.prepare("SELECT symbol, ts, close, source FROM candles WHERE source <> 'synthetic' AND ts >= ? ORDER BY symbol, ts").all(Date.now() - 45 * DAY) as { symbol: string; ts: number; close: number; source: string }[];
    let prev: { symbol: string; close: number } | null = null;
    for (const r of rows) {
      if (!(r.close > 0)) { out.push(this.finding("variation_limite", "error", r.symbol, `Clôture invalide (${r.close}) le ${new Date(r.ts).toLocaleDateString("fr-FR")} (${r.source})`, r.close, String(r.ts))); prev = null; continue; }
      if (prev && prev.symbol === r.symbol) {
        const move = (r.close / prev.close - 1) * 100;
        if (Math.abs(move) > 7.6) out.push(this.finding("variation_limite", "warning", r.symbol, `Variation de ${r1(move)} % le ${new Date(r.ts).toLocaleDateString("fr-FR")} (${r.source}) : au-delà de la limite de 7,5 % de la BRVM, opération sur le capital ou erreur de collecte à vérifier`, move, String(r.ts)));
      }
      prev = { symbol: r.symbol, close: r.close };
    }
    return out;
  }

  private checkDividends(): Finding[] {
    const out: Finding[] = [];
    if (!this.corporate) return out;
    for (const inst of INSTRUMENTS) {
      const price = this.market.price(inst.symbol) || inst.refPrice;
      const info = this.corporate.dividendInfo(inst.symbol, price);
      if (info.exceptional) out.push(this.finding("dividendes", "warning", inst.symbol, `Dernier dividende exceptionnel (rendement ${info.yieldPct} %) : rendement retenu ${info.sustainableYieldPct} %`, info.yieldPct, "exceptionnel"));
      const st = this.boc?.latest(inst.symbol);
      if (st?.lastDividend != null && st.lastDividend > 0) {
        if (!info.last || info.last.netEstimated == null) out.push(this.finding("dividendes", "info", inst.symbol, `Dernier dividende ${st.lastDividend} au bulletin, aucun dividende enregistré`, st.lastDividend, "manquant"));
        else if (Math.abs(info.last.netEstimated / st.lastDividend - 1) > 0.02) out.push(this.finding("dividendes", "warning", inst.symbol, `Dividende enregistré ${info.last.netEstimated} net contre ${st.lastDividend} au bulletin`, info.last.netEstimated, "ecart"));
      }
    }
    return out;
  }

  private checkReference(): Finding[] {
    const out: Finding[] = [];
    let noShares = 0;
    for (const inst of INSTRUMENTS) {
      const price = this.market.price(inst.symbol);
      if (price > 0) {
        const gap = Math.abs(price / inst.refPrice - 1) * 100;
        if (gap > 50) out.push(this.finding("referentiel", "warning", inst.symbol, `Cours de référence ${inst.refPrice} éloigné du cours actuel ${price} (${r1(gap)} %)`, gap, "refprice"));
      }
      if (this.quality && !(this.quality.profile(inst.symbol).sharesOutstanding ?? 0)) noShares++;
    }
    if (noShares) out.push(this.finding("referentiel", "info", null, `${noShares} valeur(s) sans nombre d'actions : capitalisation approchée par les volumes pour Black-Litterman`, noShares, "actions"));
    return out;
  }

  private checkFundamentals(now: number): Finding[] {
    const out: Finding[] = [];
    if (!this.fundamentals) return out;
    const records = this.fundamentals.records();
    const covered = new Set(records.map((r) => r.symbol));
    const missing = INSTRUMENTS.length - covered.size;
    if (missing > 0) out.push(this.finding("fondamentaux", missing > INSTRUMENTS.length / 2 ? "warning" : "info", null, `${missing} société(s) sans aucune publication structurée`, missing, "couverture"));
    const latest = new Map<string, number>();
    for (const r of records) {
      if (r.revenue != null && r.netIncome != null && r.revenue > 0 && r.netIncome > r.revenue) out.push(this.finding("fondamentaux", "warning", r.symbol, `Résultat net supérieur au chiffre d'affaires sur ${r.period} (${r.source})`, null, `${r.period}-rn`));
      if (r.equity != null && r.equity < 0) out.push(this.finding("fondamentaux", "info", r.symbol, `Capitaux propres négatifs sur ${r.period}`, r.equity, `${r.period}-cp`));
      latest.set(r.symbol, Math.max(latest.get(r.symbol) ?? 0, r.periodEnd));
    }
    const stale = [...latest.entries()].filter(([, end]) => now - end > 548 * DAY).map(([s]) => s);
    if (stale.length) out.push(this.finding("fondamentaux", "info", null, `Publications de plus de 18 mois pour ${stale.slice(0, 8).join(", ")}${stale.length > 8 ? "…" : ""}`, stale.length, "anciennete"));
    return out;
  }

  private checkBonds(): Finding[] {
    const out: Finding[] = [];
    if (!this.bonds) return out;
    const list = this.bonds.list().filter((b) => b.active);
    const stale = list.filter((b) => b.quote.stale || !(b.quote.price > 0));
    if (stale.length) out.push(this.finding("obligations", stale.length > list.length / 2 ? "warning" : "info", null, `${stale.length} obligation(s) active(s) sans cours officiel récent : ${stale.slice(0, 6).map((b) => b.code).join(", ")}${stale.length > 6 ? "…" : ""}`, stale.length, "cours"));
    for (const b of list) {
      if (!(b.quote.price > 0)) continue;
      if (b.quote.ytmPct < 0 || b.quote.ytmPct > 25) out.push(this.finding("obligations", "warning", b.code, `Rendement actuariel ${b.quote.ytmPct} % pour un cours de ${b.quote.pricePct} % du nominal : cours ou échéancier à vérifier`, b.quote.ytmPct, "ytm"));
    }
    return out;
  }

  private checkCollectors(): Finding[] {
    const out: Finding[] = [];
    const n = this.news?.status();
    if (n?.lastRun?.failed.length) out.push(this.finding("collecteurs", n.lastRun.failed.length >= n.sources.length ? "error" : "info", null, `Sources d'actualité injoignables : ${n.lastRun.failed.join(", ")}`, n.lastRun.failed.length, "actualite"));
    const d = this.documents?.status();
    if (d?.lastRun?.failed.length) out.push(this.finding("collecteurs", "info", null, `Collecte des documents : ${d.lastRun.failed.length} échec(s) (${d.lastRun.failed.slice(0, 3).join(" ; ").slice(0, 200)})`, d.lastRun.failed.length, "documents"));
    const f = this.fundamentals?.status();
    if (f?.lastScan && f.lastScan.failed > 0 && f.lastScan.failed >= f.lastScan.fetched) out.push(this.finding("collecteurs", "warning", null, `Lecture des publications : ${f.lastScan.failed} document(s) illisible(s) sur ${f.lastScan.failed + f.lastScan.fetched}`, f.lastScan.failed, "fondamentaux"));
    const ms = this.market.status();
    if (ms.provider === "simulation" && process.env.DATA_PROVIDER !== "simulation") out.push(this.finding("collecteurs", "error", null, "Cote en direct injoignable : la plateforme est repassée en simulation", null, "simulation"));
    const bs = this.bonds?.status();
    if (bs?.lastRun && !bs.lastRun.ok) out.push(this.finding("collecteurs", "warning", null, `Collecte des obligations en échec : ${bs.lastRun.error ?? ""}`.slice(0, 200), null, "obligations"));
    return out;
  }

  private checkModels(): Finding[] {
    const out: Finding[] = [];
    if (!this.models) return out;
    for (const m of this.models.list()) {
      if (!m.current) { out.push(this.finding("modeles", "info", null, `Modèle ${m.label} non publié`, null, m.key)); continue; }
      if (m.current.metrics.cvar95_1mPct != null && m.current.metrics.cvarLimitPct != null && m.current.metrics.cvar95_1mPct > m.current.metrics.cvarLimitPct) out.push(this.finding("modeles", "warning", null, `Modèle ${m.label} : CVaR ${m.current.metrics.cvar95_1mPct} % au-dessus de sa limite ${m.current.metrics.cvarLimitPct} %`, m.current.metrics.cvar95_1mPct, `${m.key}-cvar`));
      if (m.drift && m.drift.trades.length >= 3) out.push(this.finding("modeles", "info", null, `Modèle ${m.label} : la proposition du moteur s'écarte de la version publiée (${m.drift.trades.length} lignes hors bande)`, m.drift.trades.length, `${m.key}-derive`));
    }
    return out;
  }

  /** Passe tous les contrôles, calcule le score, compare au passage précédent et enregistre. */
  runChecks(now = Date.now()): QualityRun {
    const t0 = Date.now();
    const findings: Finding[] = [];
    const safe = (fn: () => Finding[], check: string) => {
      try { findings.push(...fn()); } catch (e) { findings.push(this.finding(check, "warning", null, `Contrôle impossible : ${(e as Error).message}`, null, "erreur")); }
    };
    safe(() => this.checkCoherence(now), "coherence_cours");
    safe(() => this.checkBulletinFreshness(now), "fraicheur_bulletin");
    safe(() => this.checkHistoryFreshness(now), "fraicheur_historique");
    safe(() => this.checkMoves(), "variation_limite");
    safe(() => this.checkDividends(), "dividendes");
    safe(() => this.checkReference(), "referentiel");
    safe(() => this.checkFundamentals(now), "fondamentaux");
    safe(() => this.checkBonds(), "obligations");
    safe(() => this.checkCollectors(), "collecteurs");
    safe(() => this.checkModels(), "modeles");
    findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.check.localeCompare(b.check) || (a.symbol ?? "").localeCompare(b.symbol ?? ""));
    const errors = findings.filter((f) => f.severity === "error").length;
    const warnings = findings.filter((f) => f.severity === "warning").length;
    const infos = findings.filter((f) => f.severity === "info").length;
    const score = Math.max(0, Math.round(100 - 10 * errors - 3 * warnings - 0.5 * infos));
    const checks = Object.keys(CHECK_LABELS).map((check) => {
      const fs = findings.filter((f) => f.check === check);
      const worst = fs.reduce<Severity | null>((a, f) => (a == null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[a] ? f.severity : a), null);
      return { check, label: CHECK_LABELS[check], count: fs.length, worst };
    });
    const previous = this.latestRun();
    const prevKeys = new Map((previous?.findings ?? []).map((f) => [f.key, f]));
    const curKeys = new Set(findings.map((f) => f.key));
    const changes = { added: findings.filter((f) => !prevKeys.has(f.key)), resolved: [...prevKeys.values()].filter((f) => !curKeys.has(f.key)) };
    const run: Omit<QualityRun, "id"> = { ts: now, score, errors, warnings, infos, checks, findings, changes, durationMs: Date.now() - t0 };
    const info = this.db.prepare("INSERT INTO data_quality_runs(ts, score, errors, warnings, infos, report) VALUES (?,?,?,?,?,?)").run(now, score, errors, warnings, infos, JSON.stringify(run));
    const full = { id: Number(info.lastInsertRowid), ...run };
    if (changes.added.some((f) => f.severity === "error") || (previous && score < previous.score - 10)) this.emit("alert", { kind: "quality", message: `Qualité des données : score ${score}/100 (${errors} erreur(s), ${warnings} avertissement(s))${changes.added.length ? ` · ${changes.added.length} constat(s) nouveau(x)` : ""}` });
    this.emit("run", full);
    return full;
  }

  latestRun(): QualityRun | null {
    const r = this.db.prepare("SELECT id, report FROM data_quality_runs ORDER BY ts DESC LIMIT 1").get() as { id: number; report: string } | undefined;
    if (!r) return null;
    try { return { id: r.id, ...(JSON.parse(r.report) as Omit<QualityRun, "id">) }; } catch { return null; }
  }

  scoreHistory(limit = 30): { ts: number; score: number; errors: number; warnings: number; infos: number }[] {
    return (this.db.prepare("SELECT ts, score, errors, warnings, infos FROM data_quality_runs ORDER BY ts DESC LIMIT ?").all(limit) as { ts: number; score: number; errors: number; warnings: number; infos: number }[]).reverse();
  }

  // ------------------------------------------------------------------ rapport du jour

  private ownerId(): number | null {
    const u = this.db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    return u?.id ?? null;
  }

  /** Rapport de risque du jour : place, qualité, portefeuille détenu du propriétaire, modèles ; changements depuis la veille. */
  dailyReport(now = Date.now()): DailyReport {
    const date = dayStart(now);
    const idx = this.market.indices();
    const comp = idx.find((i) => i.name === "BRVM Composite");
    const b30 = idx.find((i) => i.name === "BRVM 30");
    const snaps = this.market.allSnapshots();
    const market: DailyReport["market"] = {
      composite: comp?.value ?? 0,
      compositeChangePct: comp?.changePct ?? 0,
      brvm30: b30?.value ?? 0,
      brvm30ChangePct: b30?.changePct ?? 0,
      advancers: snaps.filter((q) => q.changePct > 0).length,
      decliners: snaps.filter((q) => q.changePct < 0).length,
      unchanged: snaps.filter((q) => q.changePct === 0).length,
      provider: this.market.status().provider,
    };
    const q = this.latestRun();
    let holdings: DailyReport["holdings"] = null;
    const owner = this.ownerId();
    if (this.holdings && owner != null) {
      try {
        const a = this.holdings.analyze(owner);
        if (a.lines.length || a.bondLines.length) {
          const worst = a.riskReport?.stress.reduce<{ label: string; totalPct: number } | null>((acc, s) => (acc == null || s.totalPct < acc.totalPct ? { label: s.label, totalPct: s.totalPct } : acc), null) ?? null;
          holdings = { total: a.totals.total, dayPct: a.performance.portfolioPct["1D"] ?? null, cvar95_1mPct: a.risk.cvar95_1mPct, cvarLimitPct: a.risk.cvarLimitPct, volatilityPct: a.risk.volatilityPct, beta: a.risk.beta, worstStress: worst, outsideBand: a.target?.trades.length ?? 0, nextReview: a.target?.rebalancing.nextReview ?? null, warnings: a.warnings.slice(0, 5) };
        }
      } catch (e) {
        holdings = null;
      }
    }
    const models: DailyReport["models"] = (this.models?.list() ?? []).map((m) => ({ key: m.key, label: m.label, version: m.version, returnNetPct: m.performance?.returnNetPct ?? null, alphaCompositePct: m.performance?.alphaCompositePct ?? null, cvar95_1mPct: m.current?.metrics.cvar95_1mPct ?? null, driftTrades: m.drift?.trades.length ?? 0 }));
    const previous = this.latestReport(date - 1);
    const changes: string[] = [];
    if (previous) {
      if (q && previous.quality && q.score < previous.quality.score - 5) changes.push(`Qualité des données en baisse : ${previous.quality.score} → ${q.score}`);
      if (q && previous.quality && q.errors > previous.quality.errors) changes.push(`${q.errors - previous.quality.errors} erreur(s) de données nouvelle(s)`);
      if (holdings && previous.holdings) {
        if (holdings.cvar95_1mPct > holdings.cvarLimitPct && previous.holdings.cvar95_1mPct <= previous.holdings.cvarLimitPct) changes.push(`Portefeuille détenu : la CVaR (${holdings.cvar95_1mPct} %) dépasse désormais la limite du profil (${holdings.cvarLimitPct} %)`);
        if (Math.abs(holdings.cvar95_1mPct - previous.holdings.cvar95_1mPct) >= 2) changes.push(`Portefeuille détenu : CVaR ${previous.holdings.cvar95_1mPct} % → ${holdings.cvar95_1mPct} %`);
        if (holdings.outsideBand > previous.holdings.outsideBand) changes.push(`Portefeuille détenu : ${holdings.outsideBand - previous.holdings.outsideBand} ligne(s) de plus hors bande de rééquilibrage`);
        if (holdings.dayPct != null && Math.abs(holdings.dayPct) >= 2) changes.push(`Portefeuille détenu : ${holdings.dayPct > 0 ? "+" : ""}${holdings.dayPct} % sur la séance`);
      }
      for (const m of models) {
        const p = previous.models.find((x) => x.key === m.key);
        if (p && m.driftTrades >= 3 && p.driftTrades < 3) changes.push(`Modèle ${m.label} : la proposition du moteur s'écarte de la version publiée (${m.driftTrades} lignes)`);
        if (p && m.version > p.version) changes.push(`Modèle ${m.label} : version ${m.version} publiée`);
      }
      if (Math.abs(market.compositeChangePct) >= 1.5) changes.push(`BRVM Composite ${market.compositeChangePct > 0 ? "+" : ""}${market.compositeChangePct} % sur la séance`);
    }
    const report: DailyReport = { date, ts: now, market, quality: q ? { score: q.score, errors: q.errors, warnings: q.warnings } : null, holdings, models, changes };
    this.db.prepare("INSERT OR REPLACE INTO daily_reports(date, ts, report) VALUES (?,?,?)").run(date, now, JSON.stringify(report));
    if (changes.length) this.emit("alert", { kind: "daily", message: `Rapport du jour : ${changes[0]}${changes.length > 1 ? ` (+${changes.length - 1})` : ""}` });
    this.emit("daily", report);
    return report;
  }

  /** Dernier rapport dont la date est ≤ `before` (ou le plus récent). */
  latestReport(before?: number): DailyReport | null {
    const r = (before != null
      ? this.db.prepare("SELECT report FROM daily_reports WHERE date <= ? ORDER BY date DESC LIMIT 1").get(before)
      : this.db.prepare("SELECT report FROM daily_reports ORDER BY date DESC LIMIT 1").get()) as { report: string } | undefined;
    if (!r) return null;
    try { return JSON.parse(r.report) as DailyReport; } catch { return null; }
  }

  reports(limit = 14): DailyReport[] {
    return (this.db.prepare("SELECT report FROM daily_reports ORDER BY date DESC LIMIT ?").all(limit) as { report: string }[]).map((r) => JSON.parse(r.report) as DailyReport);
  }

  status(): { lastRun: { ts: number; score: number; errors: number; warnings: number; infos: number } | null; lastReport: number | null; running: boolean } {
    const r = this.latestRun();
    const d = this.latestReport();
    return { lastRun: r ? { ts: r.ts, score: r.score, errors: r.errors, warnings: r.warnings, infos: r.infos } : null, lastReport: d?.date ?? null, running: this.running };
  }
}
