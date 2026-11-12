import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../data/instruments.js";
import { parseSikaCompanyPage, parseSikaHistory, parseSikaQuoteList } from "../data/sika.js";
import { isTradingDay } from "../data/providers/simulation.js";
import type { MarketService } from "./market.js";
import type { QualityService } from "./quality.js";
import { politeText } from "./fetchPolicy.js";

export interface HistoryRunStatus { at: number; ok: number; failed: string[]; inserted: number; rescaled: number; removed: number; durationMs: number }

export interface HistoryStatus {
  source: string;
  suffixes: number;
  lastRun: HistoryRunStatus | null;
  lastCapRun: { at: number; updated: number; failed: string[] } | null;
  symbols: { symbol: string; candles: number; realSince: number | null; realCandles: number }[];
  realCoverage: number; // part des valeurs disposant d'au moins une séance réelle
}

const DAY = 86_400_000;

/**
 * Historique réel des cours : lit chaque jour, après la clôture, la page « historiques » de chaque
 * valeur sur Sika Finance (environ trois mois de séances, ouverture, haut, bas, clôture, volumes)
 * et l'applique à l'historique du marché (`importRealCandles`), qui remplace les bougies de ces
 * dates et recale l'historique synthétique antérieur. Lit aussi, chaque semaine, la fiche de chaque
 * valeur pour sa capitalisation (nombre d'actions = capitalisation / cours) quand le profil
 * d'émetteur ne le renseigne pas.
 */
export class HistoryService extends EventEmitter {
  readonly base: string;
  private suffixes = new Map<string, string>();
  private lastRun: HistoryRunStatus | null = null;
  private lastCapRun: HistoryStatus["lastCapRun"] = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private quality: QualityService | null = null;
  private lastCapAt = 0;

  constructor(private readonly db: DB, private readonly market: MarketService, private readonly fetchImpl: typeof fetch = fetch) {
    super();
    this.base = process.env.SIKA_BASE ?? "https://www.sikafinance.com";
    const stored = this.db.prepare("SELECT value FROM meta WHERE key = 'sika_suffixes'").get() as { value: string } | undefined;
    if (stored) for (const [k, v] of Object.entries(JSON.parse(stored.value) as Record<string, string>)) this.suffixes.set(k, v);
  }

  attachQuality(q: QualityService): void {
    this.quality = q;
  }

  start(): void {
    if (process.env.HISTORY_COLLECT === "0") return;
    setTimeout(() => void this.refresh(), 45_000);
    this.timer = setInterval(() => void this.refreshIfDue(), 30 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Une collecte par jour ouvré après la clôture (16 h UTC), plus une au démarrage. */
  private async refreshIfDue(): Promise<void> {
    const now = new Date();
    if (!isTradingDay(now) || now.getUTCHours() < 16) return;
    const last = this.lastRun?.at ?? 0;
    if (Date.now() - last < 20 * 3600_000) return;
    await this.refresh();
  }

  /** Correspondance symbole → suffixe pays (« SNTS.sn ») lue sur la liste de A à Z. */
  async loadSuffixes(): Promise<number> {
    const html = await politeText(`${this.base}/marches/aaz`, { fetchImpl: this.fetchImpl });
    const list = parseSikaQuoteList(html);
    for (const q of list) if (INSTRUMENT_MAP.has(q.symbol)) this.suffixes.set(q.symbol, q.suffix);
    if (this.suffixes.size) this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('sika_suffixes', ?)").run(JSON.stringify(Object.fromEntries(this.suffixes)));
    return this.suffixes.size;
  }

  /** Historique d'une valeur. */
  async refreshSymbol(symbol: string): Promise<{ inserted: number; rescaled: number; removed: number }> {
    const suffix = this.suffixes.get(symbol);
    if (!suffix) throw new Error(`suffixe inconnu pour ${symbol}`);
    const html = await politeText(`${this.base}/marches/historiques/${symbol}.${suffix}`, { fetchImpl: this.fetchImpl });
    const candles = parseSikaHistory(html);
    if (!candles.length) throw new Error(`aucune séance lue pour ${symbol}`);
    const r = this.market.importRealCandles(symbol, candles, "sika");
    return r;
  }

  /** Collecte de toutes les valeurs (une page par valeur, délai de politesse entre chaque). */
  async refresh(symbols: string[] = INSTRUMENTS.map((i) => i.symbol)): Promise<HistoryRunStatus> {
    if (this.running) return this.lastRun ?? { at: Date.now(), ok: 0, failed: ["déjà en cours"], inserted: 0, rescaled: 0, removed: 0, durationMs: 0 };
    this.running = true;
    const t0 = Date.now();
    const failed: string[] = [];
    let ok = 0;
    let inserted = 0;
    let rescaled = 0;
    let removed = 0;
    try {
      if (!this.suffixes.size || symbols.some((s) => !this.suffixes.has(s))) {
        try { await this.loadSuffixes(); } catch (e) { failed.push(`liste A-Z (${(e as Error).message})`); }
      }
      for (const sym of symbols) {
        if (!this.suffixes.has(sym)) { failed.push(`${sym} (absent de la liste Sika)`); continue; }
        try {
          const r = await this.refreshSymbol(sym);
          ok++;
          inserted += r.inserted;
          rescaled += r.rescaled;
          removed += r.removed;
        } catch (e) {
          failed.push(`${sym} (${(e as Error).message})`);
        }
      }
      if (ok && Date.now() - this.lastCapAt > 7 * DAY) await this.refreshMarketCaps(symbols).catch(() => undefined);
    } finally {
      this.running = false;
    }
    this.lastRun = { at: Date.now(), ok, failed, inserted, rescaled, removed, durationMs: Date.now() - t0 };
    if (ok) this.emit("history", this.lastRun);
    return this.lastRun;
  }

  /** Capitalisations (fiche Sika) → nombre d'actions dans le profil d'émetteur, s'il n'est pas déjà saisi. */
  async refreshMarketCaps(symbols: string[] = INSTRUMENTS.map((i) => i.symbol)): Promise<{ updated: number; failed: string[] }> {
    const failed: string[] = [];
    let updated = 0;
    for (const sym of symbols) {
      const suffix = this.suffixes.get(sym);
      if (!suffix) continue;
      try {
        const html = await politeText(`${this.base}/marches/cotation_${sym}.${suffix}`, { fetchImpl: this.fetchImpl });
        const page = parseSikaCompanyPage(html);
        const price = this.market.price(sym) || INSTRUMENT_MAP.get(sym)!.refPrice;
        if (page.marketCapFcfa && price > 0 && this.quality) {
          const profile = this.quality.profile(sym);
          const shares = Math.round(page.marketCapFcfa / price);
          if (!profile.sharesOutstanding || Math.abs(profile.sharesOutstanding / shares - 1) > 0.02) {
            this.quality.saveProfile(sym, { sharesOutstanding: shares, note: profile.note ?? `Nombre d'actions déduit de la capitalisation Sika Finance (${new Date().toISOString().slice(0, 10)})` }, null);
            updated++;
          }
        }
      } catch (e) {
        failed.push(`${sym} (${(e as Error).message})`);
      }
    }
    this.lastCapAt = Date.now();
    this.lastCapRun = { at: Date.now(), updated, failed };
    return { updated, failed };
  }

  status(): HistoryStatus {
    const symbols = this.market.historyStatus();
    return { source: `${this.base}/marches/historiques/{symbole}`, suffixes: this.suffixes.size, lastRun: this.lastRun, lastCapRun: this.lastCapRun, symbols, realCoverage: symbols.length ? Math.round((symbols.filter((s) => s.realSince != null).length / symbols.length) * 100) / 100 : 0 };
  }
}
