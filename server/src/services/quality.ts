import type { DB } from "../db/index.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../data/instruments.js";
import { assessQuality, QUALITY_RULES, type CompanyProfile, type QualityResult } from "../engine/quality.js";
import type { AdvisorService } from "./advisor.js";
import type { DocumentService } from "./documents.js";
import type { MarketService } from "./market.js";
import type { NewsService } from "./news.js";
import type { CorporateService } from "./corporate.js";

const TTL = 10 * 60_000;

export interface ProfileRow {
  symbol: string; free_float_pct: number | null; main_holder_pct: number | null; main_holder_name: string | null; state_pct: number | null; shares_outstanding: number | null; payout_ratio_pct: number | null; dividend_years: number | null; suspended: number; suspended_reason: string | null; note: string | null; updated_by: number | null; updated_at: number | null;
}

export type ProfileInput = Partial<Omit<CompanyProfile, "suspended"> & { suspended: boolean; note: string | null }>;

/**
 * Score de qualité et de risque par titre : assemble les mesures de marché (liquidité, volatilité),
 * les publications collectées, l'actualité et le profil renseigné par les analystes, puis applique
 * les règles publiées (`engine/quality.ts`).
 */
export class QualityService {
  private cache = new Map<string, { at: number; r: QualityResult }>();
  private documents: DocumentService | null = null;
  private news: NewsService | null = null;
  private corporate: CorporateService | null = null;

  constructor(
    private readonly db: DB,
    private readonly market: MarketService,
    private readonly advisor: AdvisorService,
  ) {}

  /** Dividendes réels : le rendement du score devient celui du dernier dividende connu. */
  attachCorporate(c: CorporateService): void {
    this.corporate = c;
    c.on("change", () => this.cache.clear());
  }

  attach(documents: DocumentService | null, news: NewsService | null): void {
    this.documents = documents;
    this.news = news;
    documents?.on("documents", () => this.cache.clear());
  }

  rules() {
    return QUALITY_RULES;
  }

  profile(symbol: string): CompanyProfile & { note: string | null; updatedAt: number | null } {
    const r = this.db.prepare("SELECT * FROM company_profiles WHERE symbol = ?").get(symbol.toUpperCase()) as ProfileRow | undefined;
    return {
      freeFloatPct: r?.free_float_pct ?? null,
      mainHolderPct: r?.main_holder_pct ?? null,
      mainHolderName: r?.main_holder_name ?? null,
      statePct: r?.state_pct ?? null,
      sharesOutstanding: r?.shares_outstanding ?? null,
      payoutRatioPct: r?.payout_ratio_pct ?? null,
      dividendYears: r?.dividend_years ?? null,
      suspended: !!r?.suspended,
      suspendedReason: r?.suspended_reason ?? null,
      note: r?.note ?? null,
      updatedAt: r?.updated_at ?? null,
    };
  }

  /** Mise à jour partielle du profil par un analyste (les champs absents sont conservés). */
  saveProfile(symbol: string, input: ProfileInput, userId: number | null): ReturnType<QualityService["profile"]> {
    const sym = symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(sym)) throw new Error("Valeur inconnue");
    const cur = this.profile(sym);
    const v = <T>(k: keyof ProfileInput, fallback: T): T => (input[k] === undefined ? fallback : (input[k] as unknown as T));
    this.db
      .prepare(
        `INSERT INTO company_profiles(symbol, free_float_pct, main_holder_pct, main_holder_name, state_pct, shares_outstanding, payout_ratio_pct, dividend_years, suspended, suspended_reason, note, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(symbol) DO UPDATE SET free_float_pct=excluded.free_float_pct, main_holder_pct=excluded.main_holder_pct, main_holder_name=excluded.main_holder_name, state_pct=excluded.state_pct, shares_outstanding=excluded.shares_outstanding, payout_ratio_pct=excluded.payout_ratio_pct, dividend_years=excluded.dividend_years, suspended=excluded.suspended, suspended_reason=excluded.suspended_reason, note=excluded.note, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      )
      .run(sym, v("freeFloatPct", cur.freeFloatPct), v("mainHolderPct", cur.mainHolderPct), v("mainHolderName", cur.mainHolderName), v("statePct", cur.statePct), v("sharesOutstanding", cur.sharesOutstanding), v("payoutRatioPct", cur.payoutRatioPct), v("dividendYears", cur.dividendYears), v("suspended", cur.suspended) ? 1 : 0, v("suspendedReason", cur.suspendedReason), v("note", cur.note), userId, Date.now());
    this.cache.delete(sym);
    return this.profile(sym);
  }

  private sectorMedianYield(sector: string): number {
    const ys = INSTRUMENTS.filter((i) => i.sector === sector).map((i) => i.dividendYield).sort((a, b) => a - b);
    return ys.length ? ys[Math.floor(ys.length / 2)] : 4;
  }

  assess(symbol: string): QualityResult {
    const sym = symbol.toUpperCase();
    const inst = INSTRUMENT_MAP.get(sym);
    if (!inst) throw new Error("Valeur inconnue");
    const cached = this.cache.get(sym);
    if (cached && Date.now() - cached.at < TTL) return cached.r;
    const candles = this.market.history(sym, 60);
    const price = this.market.price(sym) || inst.refPrice;
    const avgValueTraded60 = candles.length ? candles.reduce((a, c) => a + c.volume * c.close, 0) / candles.length : inst.avgVolume * price;
    const zeroVolumeDays20 = candles.slice(-20).filter((c) => c.volume <= 0).length;
    const t = this.advisor.technical(sym);
    const h = this.documents?.history(sym);
    const ra = h?.latestAnnualReport;
    const res = h?.latestResults;
    const raYear = ra ? Number(ra.period?.match(/(20\d{2})/)?.[1] ?? (ra.published_at ? new Date(ra.published_at).getUTCFullYear() - 1 : NaN)) : null;
    const sentiment = this.news?.sentimentFor(sym, 30) ?? { score: 0, count: 0, headlines: [] };
    const since = Date.now() - 30 * 86_400_000;
    const suspensionMentioned = (this.news?.latest(20, sym) ?? []).some((n) => n.published_at >= since && /suspen/i.test(n.title));
    const profile = this.profile(sym);
    const r = assessQuality({
      symbol: sym,
      name: inst.name,
      sector: inst.sector,
      price,
      avgValueTraded60,
      zeroVolumeDays20,
      volatility60: t.volatility60,
      maxDrawdown250: t.maxDrawdown250,
      dividendYield: this.corporate?.yieldFor(sym, price) ?? inst.dividendYield,
      sectorMedianYield: this.sectorMedianYield(inst.sector),
      profile,
      publications: { lastAnnualReportYear: raYear != null && Number.isFinite(raYear) ? raYear : null, lastResultsDate: res?.published_at ?? null, lastResultsPeriod: res?.period ?? null, documents: h?.total ?? 0 },
      news: { score: sentiment.score, count: sentiment.count, suspensionMentioned },
    });
    this.cache.set(sym, { at: Date.now(), r });
    return r;
  }

  all(): (QualityResult & { name: string; sector: string })[] {
    return INSTRUMENTS.map((i) => ({ ...this.assess(i.symbol), name: i.name, sector: i.sector })).sort((a, b) => b.score - a.score);
  }
}
