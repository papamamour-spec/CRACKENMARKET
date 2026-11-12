import { EventEmitter } from "node:events";
import * as cheerio from "cheerio";
import type { DB } from "../db/index.js";
import { INSTRUMENT_MAP } from "../data/instruments.js";
import { parseBocText, parseLayoutConfig, type BocField, type BocRow } from "../data/boc.js";
import { isTradingDay } from "../data/providers/simulation.js";
import type { OfficialSeries } from "../engine/forecast.js";
import type { MarketService } from "./market.js";

export interface DailyStat {
  symbol: string;
  ts: number;
  ref: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  changePct: number | null;
  volume: number | null;
  value: number | null;
  trades: number | null;
  bid: number | null;
  bidQty: number | null;
  ask: number | null;
  askQty: number | null;
  /** déséquilibre des meilleures limites [-1, 1], null si quantités absentes */
  imbalance: number | null;
  reserved: "up" | "down" | null;
  suspended: boolean;
  source: string;
  fetchedAt: number;
}

export interface BocStatus {
  sources: string[];
  columns: BocField[] | null;
  sessions: number;
  lastSession: number | null;
  symbolsLastSession: number;
  lastRun: { at: number; ok: boolean; session: number | null; rows: number; applied: number; source: string | null; error: string | null } | null;
  pdfSupport: boolean;
}

interface StatRow { symbol: string; ts: number; ref_price: number | null; open: number | null; high: number | null; low: number | null; close: number | null; change_pct: number | null; volume: number | null; value: number | null; trades: number | null; bid: number | null; bid_qty: number | null; ask: number | null; ask_qty: number | null; reserved: "up" | "down" | null; suspended: number; source: string; fetched_at: number }

const dayUtc = (ts: number) => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

/** Remplace les jetons de date d'un modèle d'URL ({YYYY}, {MM}, {DD}, {YYYYMMDD}, {DD-MM-YYYY}, {DD/MM/YYYY}). */
export function expandSourceUrl(template: string, ts: number): string {
  const d = new Date(ts);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return template.replace(/\{YYYYMMDD\}/g, `${y}${m}${dd}`).replace(/\{DD-MM-YYYY\}/g, `${dd}-${m}-${y}`).replace(/\{DD\/MM\/YYYY\}/g, `${dd}/${m}/${y}`).replace(/\{YYYY\}/g, y).replace(/\{MM\}/g, m).replace(/\{DD\}/g, dd);
}

/** Texte lisible d'une page HTML : chaque ligne de tableau devient une ligne « ; » ; le reste en texte. */
export function htmlToBocText(html: string): string {
  const $ = cheerio.load(html);
  const lines: string[] = [];
  $("table").each((_, table) => {
    $(table).find("tr").each((__, tr) => {
      const cells = $(tr).find("th,td").map((___, c) => $(c).text().replace(/\s+/g, " ").trim()).get();
      if (cells.length >= 3) lines.push(cells.join(" ; "));
    });
  });
  const title = $("h1,h2,title").first().text().replace(/\s+/g, " ").trim();
  return `${title}\n${lines.join("\n")}`;
}

/** Texte d'un PDF, ligne par ligne (regroupement des fragments par ordonnée, tri par abscisse). */
export async function pdfToText(data: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true }).promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = new Map<number, { x: number; w: number; s: string }[]>();
    for (const it of tc.items) {
      if (!("str" in it) || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3) * 3;
      const arr = rows.get(y) ?? [];
      arr.push({ x: it.transform[4], w: it.width, s: it.str });
      rows.set(y, arr);
    }
    // fragments d'une même ligne : un écart horizontal net (> 6 pt) sépare deux colonnes (« ; »),
    // un petit écart est un simple espace (groupes de milliers, libellés sur plusieurs fragments)
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const items = rows.get(y)!.sort((a, b) => a.x - b.x);
      let line = "";
      let endX = -Infinity;
      for (const it of items) {
        if (line) line += it.x - endX > 6 ? " ; " : " ";
        line += it.s.trim();
        endX = it.x + it.w;
      }
      out.push(line);
    }
  }
  await doc.destroy();
  return out.join("\n");
}

/**
 * Collecte du bulletin officiel de la cote : sources configurées (`BOC_SOURCES`, modèles d'URL avec
 * jetons de date, PDF ou HTML), import collé par un administrateur, stockage par séance
 * (`daily_stats`), application aux bougies officielles et aux meilleures limites du carnet,
 * séries alignées pour le moteur de prévision.
 */
export class BocService extends EventEmitter {
  readonly sources: string[];
  readonly columns: BocField[] | null;
  private lastRun: BocStatus["lastRun"] = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: DB, private readonly market: MarketService, private readonly fetchImpl: typeof fetch = fetch) {
    super();
    this.sources = (process.env.BOC_SOURCES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    this.columns = parseLayoutConfig(process.env.BOC_COLUMNS);
    this.publishBooks();
  }

  start(): void {
    if (!this.sources.length) return;
    const run = () => this.refresh().catch((e) => console.warn(`[boc] ${(e as Error).message}`));
    setTimeout(run, 20_000);
    this.timer = setInterval(run, 60 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Dernières séances de cotation (la plus récente en premier) ; la séance du jour seulement après la clôture. */
  candidateSessions(now = Date.now(), count = 3): number[] {
    const out: number[] = [];
    const d = new Date(dayUtc(now));
    const afterClose = new Date(now).getUTCHours() >= 16;
    if (!afterClose || !isTradingDay(d)) d.setUTCDate(d.getUTCDate() - 1);
    while (out.length < count) {
      if (isTradingDay(d)) out.push(d.getTime());
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return out;
  }

  hasSession(ts: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM daily_stats WHERE ts = ? LIMIT 1").get(ts);
  }

  /** Collecte les séances récentes manquantes sur chaque source. */
  async refresh(force = false): Promise<BocStatus["lastRun"]> {
    if (!this.sources.length) {
      this.lastRun = { at: Date.now(), ok: false, session: null, rows: 0, applied: 0, source: null, error: "aucune source configurée (BOC_SOURCES)" };
      return this.lastRun;
    }
    let lastErr: string | null = null;
    for (const session of this.candidateSessions()) {
      if (!force && this.hasSession(session)) continue;
      for (const template of this.sources) {
        const url = expandSourceUrl(template, session);
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 20_000);
          const res = await this.fetchImpl(url, { signal: ctrl.signal, headers: { "user-agent": "CrackenMarket/0.1 (+boc-collector)" } });
          clearTimeout(t);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = new Uint8Array(await res.arrayBuffer());
          const isPdf = (res.headers.get("content-type") ?? "").includes("pdf") || (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46);
          const text = isPdf ? await pdfToText(buf) : htmlToBocText(new TextDecoder().decode(buf));
          const r = this.importText(text, session, url);
          if (r.applied > 0) {
            this.lastRun = { at: Date.now(), ok: true, session: r.session, rows: r.rows, applied: r.applied, source: url, error: null };
            return this.lastRun;
          }
          lastErr = `${url} : aucune ligne reconnue`;
        } catch (e) {
          lastErr = `${url} : ${(e as Error).message}`;
        }
      }
    }
    this.lastRun = { at: Date.now(), ok: lastErr == null, session: null, rows: 0, applied: 0, source: null, error: lastErr ?? "rien à collecter (séances déjà en base)" };
    return this.lastRun;
  }

  /** Import d'un bulletin (texte collé ou extrait) ; la date passée l'emporte sur celle du texte. */
  importText(text: string, sessionTs: number | null = null, source = "import"): { session: number; rows: number; applied: number; unrecognized: number; layout: BocField[]; layoutSource: string } {
    const parsed = parseBocText(text, this.columns);
    const session = sessionTs != null ? dayUtc(sessionTs) : parsed.sessionTs;
    if (session == null) throw new Error("Date de séance introuvable : précisez-la.");
    if (!parsed.rows.length) throw new Error("Aucune ligne de cote reconnue (le symbole BRVM doit ouvrir chaque ligne).");
    const applied = this.apply(parsed.rows, session, source);
    return { session, rows: parsed.rows.length, applied, unrecognized: parsed.unrecognized, layout: parsed.layout, layoutSource: parsed.layoutSource };
  }

  /** Enregistre les lignes d'une séance, met à jour les bougies officielles et les meilleures limites. */
  apply(rows: BocRow[], session: number, source: string): number {
    const ins = this.db.prepare(
      `INSERT INTO daily_stats(symbol, ts, ref_price, open, high, low, close, change_pct, volume, value, trades, bid, bid_qty, ask, ask_qty, reserved, suspended, source, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(symbol, ts) DO UPDATE SET ref_price=COALESCE(excluded.ref_price, daily_stats.ref_price), open=COALESCE(excluded.open, daily_stats.open), high=COALESCE(excluded.high, daily_stats.high), low=COALESCE(excluded.low, daily_stats.low), close=COALESCE(excluded.close, daily_stats.close), change_pct=COALESCE(excluded.change_pct, daily_stats.change_pct), volume=COALESCE(excluded.volume, daily_stats.volume), value=COALESCE(excluded.value, daily_stats.value), trades=COALESCE(excluded.trades, daily_stats.trades), bid=COALESCE(excluded.bid, daily_stats.bid), bid_qty=COALESCE(excluded.bid_qty, daily_stats.bid_qty), ask=COALESCE(excluded.ask, daily_stats.ask), ask_qty=COALESCE(excluded.ask_qty, daily_stats.ask_qty), reserved=COALESCE(excluded.reserved, daily_stats.reserved), suspended=excluded.suspended, source=excluded.source, fetched_at=excluded.fetched_at`,
    );
    let n = 0;
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        if (!INSTRUMENT_MAP.has(r.symbol)) continue;
        ins.run(r.symbol, session, r.ref, r.open, r.high, r.low, r.close, r.changePct, r.volume, r.value, r.trades, r.bid, r.bidQty, r.ask, r.askQty, r.reserved, r.suspended ? 1 : 0, source, Date.now());
        n++;
        const close = r.close ?? (r.volume === 0 ? r.ref : null);
        if (close != null && close > 0) {
          this.market.applyOfficialCandle(r.symbol, { ts: session, open: r.open ?? close, high: r.high ?? Math.max(r.open ?? close, close), low: r.low ?? Math.min(r.open ?? close, close), close, volume: r.volume ?? 0 });
        }
      }
    });
    tx();
    this.publishBooks();
    if (n) this.emit("boc", { session, rows: n });
    return n;
  }

  /** Meilleures limites de la dernière séance connue de chaque valeur, transmises au carnet. */
  private publishBooks(): void {
    const rows = this.db.prepare("SELECT d.* FROM daily_stats d JOIN (SELECT symbol, MAX(ts) AS ts FROM daily_stats GROUP BY symbol) m ON m.symbol = d.symbol AND m.ts = d.ts").all() as StatRow[];
    for (const r of rows) {
      if (r.bid == null && r.ask == null) continue;
      this.market.setOfficialBook(r.symbol, { bid: r.bid, bidQty: r.bid_qty, ask: r.ask, askQty: r.ask_qty, ts: r.ts, source: r.source });
    }
  }

  private view(r: StatRow): DailyStat {
    const bidV = r.bid != null && r.bid_qty != null ? r.bid * r.bid_qty : null;
    const askV = r.ask != null && r.ask_qty != null ? r.ask * r.ask_qty : null;
    const imbalance = bidV != null && askV != null && bidV + askV > 0 ? Math.round(((bidV - askV) / (bidV + askV)) * 100) / 100 : bidV != null && askV == null && r.ask == null ? 1 : askV != null && bidV == null && r.bid == null ? -1 : null;
    return { symbol: r.symbol, ts: r.ts, ref: r.ref_price, open: r.open, high: r.high, low: r.low, close: r.close, changePct: r.change_pct, volume: r.volume, value: r.value, trades: r.trades, bid: r.bid, bidQty: r.bid_qty, ask: r.ask, askQty: r.ask_qty, imbalance, reserved: r.reserved, suspended: !!r.suspended, source: r.source, fetchedAt: r.fetched_at };
  }

  stats(symbol: string, limit = 60): DailyStat[] {
    return (this.db.prepare("SELECT * FROM daily_stats WHERE symbol = ? ORDER BY ts DESC LIMIT ?").all(symbol.toUpperCase(), limit) as StatRow[]).map((r) => this.view(r)).reverse();
  }

  latest(symbol: string): DailyStat | null {
    const r = this.db.prepare("SELECT * FROM daily_stats WHERE symbol = ? ORDER BY ts DESC LIMIT 1").get(symbol.toUpperCase()) as StatRow | undefined;
    return r ? this.view(r) : null;
  }

  /** Toutes les lignes d'une séance (la dernière par défaut). */
  session(ts?: number): { ts: number | null; items: DailyStat[] } {
    const t = ts ?? ((this.db.prepare("SELECT MAX(ts) AS ts FROM daily_stats").get() as { ts: number | null }).ts);
    if (t == null) return { ts: null, items: [] };
    return { ts: t, items: (this.db.prepare("SELECT * FROM daily_stats WHERE ts = ? ORDER BY symbol").all(t) as StatRow[]).map((r) => this.view(r)) };
  }

  /** Séries alignées sur des dates de bougies (null là où aucun bulletin n'est connu). */
  series(symbol: string, dates: number[]): OfficialSeries | null {
    if (!dates.length) return null;
    const rows = this.db.prepare("SELECT * FROM daily_stats WHERE symbol = ? AND ts >= ? ORDER BY ts").all(symbol.toUpperCase(), dates[0]) as StatRow[];
    if (!rows.length) return null;
    const byTs = new Map(rows.map((r) => [r.ts, this.view(r)]));
    return {
      imbalance: dates.map((t) => byTs.get(t)?.imbalance ?? null),
      reserved: dates.map((t) => { const r = byTs.get(t); return r ? (r.reserved === "up" ? 1 : r.reserved === "down" ? -1 : 0) : null; }),
    };
  }

  /** Mesures d'activité récentes pour une valeur (transactions, réservations), sur les séances connues. */
  activity(symbol: string, sessions = 20): { sessions: number; avgTrades: number | null; reservedUp: number; reservedDown: number; suspendedDays: number; lastImbalance: number | null } {
    const s = this.stats(symbol, sessions);
    const trades = s.map((x) => x.trades).filter((x): x is number => x != null);
    return { sessions: s.length, avgTrades: trades.length ? Math.round((trades.reduce((a, b) => a + b, 0) / trades.length) * 10) / 10 : null, reservedUp: s.filter((x) => x.reserved === "up").length, reservedDown: s.filter((x) => x.reserved === "down").length, suspendedDays: s.filter((x) => x.suspended).length, lastImbalance: s[s.length - 1]?.imbalance ?? null };
  }

  status(): BocStatus {
    const agg = this.db.prepare("SELECT COUNT(DISTINCT ts) AS sessions, MAX(ts) AS last FROM daily_stats").get() as { sessions: number; last: number | null };
    const n = agg.last != null ? (this.db.prepare("SELECT COUNT(*) AS n FROM daily_stats WHERE ts = ?").get(agg.last) as { n: number }).n : 0;
    return { sources: this.sources, columns: this.columns, sessions: agg.sessions, lastSession: agg.last, symbolsLastSession: n, lastRun: this.lastRun, pdfSupport: true };
  }
}

export type { OfficialSeries };
