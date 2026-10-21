import { EventEmitter } from "node:events";
import * as cheerio from "cheerio";
import type { DB } from "../db/index.js";
import { BONDS, BRVM_COTE_SNAPSHOT, BRVM_COTE_SNAPSHOT_DATE, LEGACY_SEED_CODES, defFromLabel, parseCoteText, type Amortization, type BondDef, type CoteRow, type IssuerType } from "../data/bonds.js";
import { analyzeBond, cleanPrice, fullSchedule, outstandingAt, type BondAnalytics } from "../engine/bonds.js";

export interface BondQuote {
  code: string;
  price: number; // pied de coupon, FCFA par obligation (sur le capital restant dû)
  pricePct: number; // cours officiel BRVM : % du nominal restant dû
  ytmPct: number;
  changePct: number; // variation vs veille
  volume: number;
  suspended: boolean;
  ts: number;
  source: "brvm" | "admin" | "simulation";
}

export interface BondView extends BondDef {
  active: boolean;
  source: "seed" | "brvm" | "admin";
  quote: BondQuote;
  analytics: Omit<BondAnalytics, "flows">;
}

interface BondRow {
  code: string; name: string; issuer: string; issuer_type: IssuerType; country: string; coupon_pct: number; issue_date: string; maturity_date: string; nominal: number; frequency: number; amortization: Amortization; grace_years: number; tax_exempt: number; active: number;
  source: "seed" | "brvm" | "admin"; dates_estimated: number; quoted_pct: number | null; prev_pct: number | null; quoted_at: number | null; quote_source: "brvm" | "admin" | null; volume: number; suspended: number;
}

export interface BondSourceStatus {
  sources: string[];
  snapshotDate: string;
  lastRun: { at: number; ok: boolean; rows: number; inserted: number; updated: number; error: string | null } | null;
  quoted: number; // lignes avec un cours officiel récent
  total: number;
}

const DAY = 86_400_000;
const QUOTE_MAX_AGE = 10 * DAY;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Écart de rendement indicatif par type d'émetteur (points de %) par rapport au coupon. */
const SPREAD: Record<IssuerType, number> = { souverain: 0.1, supranational: -0.2, entreprise: 0.9 };

/** Part obligataire cible (%) selon le profil : prudence, objectif et horizon. */
export function targetBondSharePct(riskTolerance: number, objective: "income" | "growth" | "balanced" | "speculative", horizonMonths: number): number {
  const tol = Math.max(1, Math.min(5, Math.round(riskTolerance)));
  let share = { 1: 55, 2: 45, 3: 30, 4: 15, 5: 5 }[tol as 1 | 2 | 3 | 4 | 5];
  share += objective === "income" ? 10 : objective === "growth" ? -5 : objective === "speculative" ? -10 : 0;
  if (horizonMonths < 24) share += 10;
  else if (horizonMonths > 96) share -= 5;
  return Math.max(0, Math.min(70, share));
}

export interface BondAllocationLine {
  code: string;
  name: string;
  issuer: string;
  issuerType: IssuerType;
  price: number; // pied de coupon, FCFA
  pricePct: number;
  accrued: number;
  quantity: number;
  amount: number; // coupon attaché
  weightPct: number; // du budget obligataire
  couponPct: number;
  ytmPct: number;
  durationYears: number;
  remainingYears: number;
  maturityDate: string;
  annualCoupon: number;
  taxExempt: boolean;
  rationale: string;
}

/** Analyse d'une page HTML de la cote obligataire (brvm.org) : chaque ligne de tableau devient une ligne de texte. */
export function parseCoteHtml(html: string): CoteRow[] {
  const $ = cheerio.load(html);
  const lines: string[] = [];
  $("tr").each((_, tr) => {
    const cells = $(tr).find("td").map((_i, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
    if (cells.length >= 4) lines.push(cells.join("\t"));
  });
  return parseCoteText(lines.join("\n"));
}

/**
 * Compartiment obligataire : référentiel en base amorcé depuis l'instantané de la cote officielle,
 * tenu à jour par collecte sur brvm.org (ou collage du tableau par un administrateur), cours en
 * pourcentage du nominal, calculs obligataires et historique de prix pour la mesure du risque.
 */
export class BondService extends EventEmitter {
  private histCache = new Map<string, { day: number; closes: { ts: number; close: number }[] }>();
  private timer: NodeJS.Timeout | null = null;
  private lastRun: BondSourceStatus["lastRun"] = null;
  private readonly sources: string[];

  constructor(
    private readonly db: DB,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    this.sources = (process.env.BOND_SOURCES ?? "https://www.brvm.org/fr/cours-obligations/0").split(",").map((s) => s.trim()).filter(Boolean);
    this.seed();
  }

  /** Amorçage et migration : lignes de la cote officielle, désactivation de l'ancien référentiel fictif. */
  private seed(): void {
    const existing = new Set((this.db.prepare("SELECT code FROM bonds").all() as { code: string }[]).map((r) => r.code));
    const snapshotCodes = new Set(BONDS.map((b) => b.code));
    for (const code of LEGACY_SEED_CODES) {
      if (existing.has(code) && !snapshotCodes.has(code)) {
        const r = this.db.prepare("SELECT source FROM bonds WHERE code = ?").get(code) as { source: string };
        if (r.source === "seed") this.db.prepare("UPDATE bonds SET active = 0 WHERE code = ?").run(code);
      }
    }
    const snapshotAt = Date.parse(BRVM_COTE_SNAPSHOT_DATE);
    this.applyCote(parseCoteText(BRVM_COTE_SNAPSHOT), "seed", snapshotAt, true);
  }

  /**
   * Applique des lignes de cote : création des émissions inconnues (caractéristiques déduites du
   * libellé), mise à jour des cours, désactivation des lignes échues sans cours.
   */
  applyCote(rows: CoteRow[], source: "seed" | "brvm" | "admin", at = Date.now(), onlyIfNewer = false): { inserted: number; updated: number } {
    let inserted = 0;
    let updated = 0;
    const year = new Date(at).getUTCFullYear();
    const sel = this.db.prepare("SELECT * FROM bonds WHERE code = ?");
    const ins = this.db.prepare(
      `INSERT INTO bonds(code, name, issuer, issuer_type, country, coupon_pct, issue_date, maturity_date, nominal, frequency, amortization, grace_years, tax_exempt, active, source, dates_estimated, quoted_pct, prev_pct, quoted_at, quote_source, volume, suspended)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        const def = defFromLabel(r.code, r.label);
        const matured = r.closePct == null && Number(def.maturityDate.slice(0, 4)) <= year;
        const existing = sel.get(r.code) as BondRow | undefined;
        const quoteSource = source === "seed" ? "brvm" : source;
        if (!existing) {
          ins.run(def.code, def.name, def.issuer, def.issuerType, def.country, def.couponPct, def.issueDate, def.maturityDate, def.nominal, def.frequency, def.amortization, def.graceYears, def.taxExempt ? 1 : 0, matured ? 0 : 1, source === "admin" ? "brvm" : source, 1, r.closePct, r.prevPct, r.closePct != null ? at : null, r.closePct != null ? quoteSource : null, r.volume, r.suspended ? 1 : 0);
          inserted++;
          continue;
        }
        if (onlyIfNewer && existing.quoted_at && existing.quoted_at >= at) continue;
        // caractéristiques : le libellé officiel prime sur une déduction antérieure, jamais sur une saisie administrateur
        const keepAdmin = existing.source === "admin" && !existing.dates_estimated;
        this.db
          .prepare(
            `UPDATE bonds SET name = ?, issuer = ?, issuer_type = ?, country = ?, coupon_pct = ?, tax_exempt = ?,
               issue_date = CASE WHEN ? THEN issue_date ELSE ? END, maturity_date = CASE WHEN ? THEN maturity_date ELSE ? END,
               active = ?, quoted_pct = COALESCE(?, quoted_pct), prev_pct = COALESCE(?, prev_pct), quoted_at = CASE WHEN ? IS NULL THEN quoted_at ELSE ? END,
               quote_source = CASE WHEN ? IS NULL THEN quote_source ELSE ? END, volume = ?, suspended = ?
             WHERE code = ?`,
          )
          .run(keepAdmin ? existing.name : def.name, keepAdmin ? existing.issuer : def.issuer, keepAdmin ? existing.issuer_type : def.issuerType, keepAdmin ? existing.country : def.country, keepAdmin ? existing.coupon_pct : def.couponPct, keepAdmin ? existing.tax_exempt : def.taxExempt ? 1 : 0,
            keepAdmin ? 1 : 0, def.issueDate, keepAdmin ? 1 : 0, def.maturityDate,
            matured ? 0 : 1, r.closePct, r.prevPct, r.closePct, at, r.closePct, quoteSource, r.volume, r.suspended ? 1 : 0, r.code);
        updated++;
      }
    });
    tx();
    this.histCache.clear();
    if (inserted || updated) this.emit("bonds", { inserted, updated });
    return { inserted, updated };
  }

  /** Collage du tableau de la cote par un administrateur. */
  importCote(text: string): { inserted: number; updated: number; rows: number; unrecognized: number } {
    const rows = parseCoteText(text);
    const res = this.applyCote(rows, "admin");
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
    return { ...res, rows: rows.length, unrecognized: Math.max(0, lines - rows.length) };
  }

  /** Collecte sur brvm.org (pages configurées par BOND_SOURCES ; pagination « ?page=n » tentée jusqu'à épuisement). */
  async refresh(): Promise<BondSourceStatus["lastRun"]> {
    const seen = new Set<string>();
    const rows: CoteRow[] = [];
    let error: string | null = null;
    try {
      for (const base of this.sources) {
        for (let page = 0; page < 10; page++) {
          const url = page === 0 ? base : `${base}${base.includes("?") ? "&" : "?"}page=${page}`;
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 15_000);
          const res = await this.fetchImpl(url, { signal: ctrl.signal, headers: { "user-agent": "CrackenMarket/0.1 (+cote-obligations)" } });
          clearTimeout(t);
          if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
          const parsed = parseCoteHtml(await res.text()).filter((r) => !seen.has(r.code));
          if (!parsed.length) break;
          for (const r of parsed) seen.add(r.code);
          rows.push(...parsed);
        }
      }
    } catch (e) {
      error = (e as Error).message;
    }
    const applied = rows.length ? this.applyCote(rows, "brvm") : { inserted: 0, updated: 0 };
    this.lastRun = { at: Date.now(), ok: !error && rows.length > 0, rows: rows.length, inserted: applied.inserted, updated: applied.updated, error: error ?? (rows.length ? null : "aucune ligne reconnue") };
    if (error) console.warn(`[bonds] collecte de la cote obligataire : ${error}`);
    return this.lastRun;
  }

  start(intervalMs = 30 * 60_000): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  status(): BondSourceStatus {
    const listed = this.list();
    const total = listed.length;
    const quoted = listed.filter((v) => v.quote.source !== "simulation").length;
    return { sources: this.sources, snapshotDate: BRVM_COTE_SNAPSHOT_DATE, lastRun: this.lastRun, quoted, total };
  }

  private toDef(r: BondRow): BondDef & { active: boolean; source: BondRow["source"]; quotedPct: number | null; prevPct: number | null; quotedAt: number | null; quoteSource: BondRow["quote_source"]; volume: number; suspended: boolean } {
    return { code: r.code, name: r.name, issuer: r.issuer, issuerType: r.issuer_type, country: r.country, couponPct: r.coupon_pct, issueDate: r.issue_date, maturityDate: r.maturity_date, nominal: r.nominal, frequency: r.frequency as 1 | 2 | 4, amortization: r.amortization, graceYears: r.grace_years, taxExempt: !!r.tax_exempt, datesEstimated: !!r.dates_estimated, active: !!r.active, source: r.source, quotedPct: r.quoted_pct, prevPct: r.prev_pct, quotedAt: r.quoted_at, quoteSource: r.quote_source, volume: r.volume ?? 0, suspended: !!r.suspended };
  }

  defs(includeInactive = false): ReturnType<BondService["toDef"]>[] {
    const rows = this.db.prepare(`SELECT * FROM bonds ${includeInactive ? "" : "WHERE active = 1"} ORDER BY maturity_date, code`).all() as BondRow[];
    return rows.map((r) => this.toDef(r));
  }

  def(code: string): ReturnType<BondService["toDef"]> | undefined {
    const r = this.db.prepare("SELECT * FROM bonds WHERE code = ?").get(code.toUpperCase()) as BondRow | undefined;
    return r ? this.toDef(r) : undefined;
  }

  has(code: string): boolean {
    return !!this.def(code);
  }

  /** Rendement indicatif simulé au jour j (retour à la moyenne vers coupon + écart), utilisé sans cours officiel récent. */
  private simulatedYield(b: BondDef, dayIndex: number): number {
    const rand = mulberry32(hash(b.code));
    const base = b.couponPct + SPREAD[b.issuerType];
    let y = base;
    const steps = Math.max(0, Math.min(400, dayIndex));
    const start = Math.max(0, dayIndex - 400);
    for (let i = 0; i < start; i++) rand();
    for (let i = 0; i < steps; i++) y += 0.15 * (base - y) + (rand() - 0.5) * 0.08;
    return y;
  }

  private dayIndex(ts: number): number {
    return Math.floor(ts / DAY);
  }

  /** Cours pied de coupon en % du nominal restant dû à une date (cours officiel s'il est récent, sinon indicatif). */
  pricePctAt(b: ReturnType<BondService["toDef"]>, at = Date.now(), allowOfficial = true): { pct: number; official: boolean } {
    if (allowOfficial && b.quotedPct != null && b.quotedAt != null && at - b.quotedAt <= QUOTE_MAX_AGE && at >= b.quotedAt - DAY) return { pct: b.quotedPct, official: true };
    const y = this.simulatedYield(b, this.dayIndex(at)) / 100;
    const outstanding = outstandingAt(b, at);
    return { pct: outstanding > 0 ? Math.round((cleanPrice(b, y, at) / outstanding) * 10000) / 100 : 0, official: false };
  }

  quote(code: string): BondQuote | undefined {
    const b = this.def(code);
    if (!b) return undefined;
    const now = Date.now();
    const { pct, official } = this.pricePctAt(b, now);
    const outstanding = outstandingAt(b, now);
    const price = Math.round(((pct / 100) * outstanding) * 100) / 100;
    const prevPct = official && b.prevPct ? b.prevPct : this.pricePctAt(b, now - DAY, false).pct;
    const a = analyzeBond(b, price, now);
    return {
      code: b.code,
      price,
      pricePct: pct,
      ytmPct: Math.round(a.ytmPct * 100) / 100,
      changePct: prevPct ? Math.round(((pct - prevPct) / prevPct) * 10000) / 100 : 0,
      volume: official ? b.volume : 0,
      suspended: b.suspended,
      ts: official ? b.quotedAt! : now,
      source: official ? (b.quoteSource ?? "brvm") : "simulation",
    };
  }

  view(code: string): BondView | undefined {
    const b = this.def(code);
    if (!b) return undefined;
    const q = this.quote(code)!;
    const { flows: _flows, ...analytics } = analyzeBond(b, q.price);
    return { ...b, quote: q, analytics: round(analytics) };
  }

  list(): BondView[] {
    return this.defs().map((b) => this.view(b.code)!).filter((v) => v.analytics.remainingYears > 0);
  }

  detail(code: string): (BondView & { schedule: ReturnType<typeof fullSchedule>; flows: BondAnalytics["flows"] }) | undefined {
    const v = this.view(code);
    if (!v) return undefined;
    const a = analyzeBond(v, v.quote.price);
    return { ...v, schedule: fullSchedule(v), flows: a.flows };
  }

  /** Historique quotidien de prix pied de coupon (FCFA par obligation) pour la mesure du risque. */
  history(code: string, days = 260): { ts: number; close: number }[] {
    const b = this.def(code);
    if (!b) return [];
    const today = this.dayIndex(Date.now());
    const cached = this.histCache.get(code);
    if (cached && cached.day === today && cached.closes.length >= days) return cached.closes.slice(-days);
    const closes: { ts: number; close: number }[] = [];
    const issue = this.dayIndex(new Date(b.issueDate).getTime());
    for (let d = today - days; d <= today; d++) {
      if (d < issue) continue;
      const ts = d * DAY;
      const { pct } = this.pricePctAt(b, ts, d === today);
      closes.push({ ts, close: (pct / 100) * outstandingAt(b, ts) });
    }
    this.histCache.set(code, { day: today, closes });
    return closes;
  }

  /** Administration : création ou mise à jour complète d'une obligation (caractéristiques précises). */
  upsert(input: BondDef & { active?: boolean }): BondView {
    this.db
      .prepare(
        `INSERT INTO bonds(code, name, issuer, issuer_type, country, coupon_pct, issue_date, maturity_date, nominal, frequency, amortization, grace_years, tax_exempt, active, source, dates_estimated)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'admin',0)
         ON CONFLICT(code) DO UPDATE SET name=excluded.name, issuer=excluded.issuer, issuer_type=excluded.issuer_type, country=excluded.country, coupon_pct=excluded.coupon_pct, issue_date=excluded.issue_date, maturity_date=excluded.maturity_date, nominal=excluded.nominal, frequency=excluded.frequency, amortization=excluded.amortization, grace_years=excluded.grace_years, tax_exempt=excluded.tax_exempt, active=excluded.active, source='admin', dates_estimated=0`,
      )
      .run(input.code.toUpperCase(), input.name, input.issuer, input.issuerType, input.country, input.couponPct, input.issueDate, input.maturityDate, input.nominal, input.frequency, input.amortization, input.graceYears, input.taxExempt ? 1 : 0, input.active === false ? 0 : 1);
    this.histCache.delete(input.code.toUpperCase());
    return this.view(input.code)!;
  }

  /** Administration : cours officiel saisi en % du nominal (null pour l'effacer). */
  setPrice(code: string, pricePct: number | null): BondView {
    if (!this.has(code)) throw new Error("Obligation inconnue");
    this.db.prepare("UPDATE bonds SET quoted_pct = ?, quoted_at = ?, quote_source = ? WHERE code = ?").run(pricePct, pricePct ? Date.now() : null, pricePct ? "admin" : null, code.toUpperCase());
    this.histCache.delete(code.toUpperCase());
    return this.view(code)!;
  }

  /**
   * Sélection d'obligations pour un budget : échéance compatible avec l'horizon (au plus horizon + 3 ans,
   * au moins 1 an restant), classement par rendement actuariel corrigé du risque émetteur, diversification
   * des émetteurs (au plus 40 % du budget par émetteur), jusqu'à `maxLines` lignes. Les lignes suspendues
   * ou sans cours officiel récent sont écartées quand des lignes cotées suffisent.
   */
  suggest(budget: number, horizonMonths: number, maxLines = 4, exclude: string[] = [], riskTolerance = 3): BondAllocationLine[] {
    if (!(budget > 0)) return [];
    const maxYears = Math.max(2, horizonMonths / 12 + 3);
    const riskPenalty: Record<IssuerType, number> = { souverain: 0, supranational: 0, entreprise: riskTolerance <= 2 ? 1.5 : riskTolerance === 3 ? 0.8 : 0.4 };
    const all = this.list().filter((v) => !exclude.includes(v.code) && !v.quote.suspended && v.analytics.remainingYears >= 1 && v.analytics.remainingYears <= maxYears);
    const official = all.filter((v) => v.quote.source !== "simulation");
    const pool = official.length >= 3 ? official : all;
    const candidates = pool
      .map((v) => ({ v, score: v.analytics.ytmPct - riskPenalty[v.issuerType] + (v.taxExempt ? 0.3 : 0) }))
      .sort((a, b) => b.score - a.score);
    const chosen: { v: BondView; weight: number }[] = [];
    const issuerBudget = new Map<string, number>();
    for (const c of candidates) {
      if (chosen.length >= maxLines) break;
      const used = issuerBudget.get(c.v.issuer) ?? 0;
      if (used >= 0.4) continue;
      const w = Math.min(0.4 - used, chosen.length === 0 ? 0.4 : 0.3);
      chosen.push({ v: c.v, weight: w });
      issuerBudget.set(c.v.issuer, used + w);
    }
    const totalW = chosen.reduce((a, c) => a + c.weight, 0) || 1;
    const out: BondAllocationLine[] = [];
    for (const c of chosen) {
      const dirty = c.v.quote.price + c.v.analytics.accrued;
      const amount = (budget * c.weight) / totalW;
      const quantity = Math.floor(amount / dirty);
      if (quantity <= 0) continue;
      out.push({
        code: c.v.code,
        name: c.v.name,
        issuer: c.v.issuer,
        issuerType: c.v.issuerType,
        price: c.v.quote.price,
        pricePct: c.v.quote.pricePct,
        accrued: c.v.analytics.accrued,
        quantity,
        amount: Math.round(quantity * dirty),
        weightPct: 0,
        couponPct: c.v.couponPct,
        ytmPct: c.v.analytics.ytmPct,
        durationYears: c.v.analytics.modifiedDuration,
        remainingYears: c.v.analytics.remainingYears,
        maturityDate: c.v.maturityDate,
        annualCoupon: Math.round(c.v.analytics.annualCoupon * quantity),
        taxExempt: c.v.taxExempt,
        rationale: `${c.v.issuerType === "souverain" ? "Emprunt d'État" : c.v.issuerType === "supranational" ? "Émetteur supranational" : "Obligation d'entreprise"}, cours ${c.v.quote.pricePct} % du nominal (${c.v.quote.source === "simulation" ? "indicatif" : "cote BRVM"}), rendement actuariel ${c.v.analytics.ytmPct.toFixed(2)} %${c.v.taxExempt ? " exonéré d'impôt" : ""}, échéance ${c.v.maturityDate.slice(0, 4)} (${c.v.analytics.remainingYears.toFixed(1)} ans)`,
      });
    }
    const sum = out.reduce((a, l) => a + l.amount, 0) || 1;
    for (const l of out) l.weightPct = Math.round((l.amount / sum) * 1000) / 10;
    return out;
  }

  deactivate(code: string): void {
    this.db.prepare("UPDATE bonds SET active = 0 WHERE code = ?").run(code.toUpperCase());
  }
}

function round<T extends Record<string, unknown>>(a: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) out[k] = typeof v === "number" ? Math.round(v * 100) / 100 : v;
  return out as T;
}
