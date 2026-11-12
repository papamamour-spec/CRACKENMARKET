import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { INSTRUMENTS, INSTRUMENT_MAP } from "../data/instruments.js";
import { buildEventCalendar, type MarketEvent } from "../data/events.js";
import { detectSplits, parseDividendNotice, type CorporateAction, type CorporateKind } from "../engine/corporate.js";
import type { MarketService } from "./market.js";
import type { NewsService } from "./news.js";
import type { DocumentService } from "./documents.js";
import { parseSikaDividends } from "../data/sika.js";
import { politeText } from "./fetchPolicy.js";

/**
 * Retenue à la source appliquée aux dividendes (IRVM, 10 % pour les sociétés cotées dans la
 * plupart des pays de l'UEMOA) : sert à estimer le net quand seul le brut est publié.
 */
export const DIVIDEND_WITHHOLDING = 0.10;

export type ActionKind = Exclude<CorporateKind, "dividend">;
export type ActionStatus = "confirmé" | "suspecté";
export type DividendStatus = "proposé" | "approuvé" | "payé";

export interface CorporateActionView {
  id: number;
  symbol: string;
  name: string;
  kind: ActionKind;
  exDate: number;
  ratio: number | null;
  status: ActionStatus;
  source: string;
  note: string | null;
  updatedAt: number;
}

export interface DividendView {
  id: number;
  symbol: string;
  name: string;
  fiscalYear: number;
  gross: number | null;
  net: number | null;
  /** net retenu pour les calculs : net publié, sinon brut après retenue à la source */
  netEstimated: number | null;
  exDate: number | null;
  paymentDate: number | null;
  agmDate: number | null;
  status: DividendStatus;
  source: string;
  url: string | null;
  note: string | null;
  updatedAt: number;
}

export interface DividendInfo {
  last: DividendView | null;
  /** rendement net sur le dernier dividende connu (%), null si inconnu */
  yieldPct: number | null;
  /** prochain détachement connu (dans le futur) */
  next: { exDate: number; amount: number; fiscalYear: number; status: DividendStatus } | null;
  /** nombre d'exercices renseignés */
  years: number;
}

export interface ActionInput { symbol: string; kind: ActionKind; exDate: string | number; ratio: number; note?: string | null; status?: ActionStatus; source?: string }
export interface DividendInput { symbol: string; fiscalYear: number; gross?: number | null; net?: number | null; exDate?: string | number | null; paymentDate?: string | number | null; agmDate?: string | number | null; status?: DividendStatus; source?: string; url?: string | null; note?: string | null }

interface ActionRow { id: number; symbol: string; kind: ActionKind; ex_date: number; ratio: number | null; status: ActionStatus; source: string; note: string | null; updated_at: number }
interface DividendRow { id: number; symbol: string; fiscal_year: number; gross: number | null; net: number | null; ex_date: number | null; payment_date: number | null; agm_date: number | null; status: DividendStatus; source: string; url: string | null; note: string | null; updated_at: number }

const DAY = 86_400_000;
const STATUS_RANK: Record<DividendStatus, number> = { proposé: 0, approuvé: 1, payé: 2 };
/** sources par ordre de fiabilité croissante : une source moins fiable n'écrase jamais une plus fiable */
const SOURCE_RANK = (s: string) => (s === "analyste" || s === "admin" ? 3 : s === "import" ? 2 : 1);

export function toDayTs(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Actions sur le capital (fractionnements, regroupements, attributions) et dividendes réels :
 * saisie par les analystes, import en bloc, lecture automatique des avis dans l'actualité et les
 * documents collectés, détection des fractionnements suspects dans l'historique. Fournit aux
 * autres services la liste des ajustements, le rendement réel et le calendrier des détachements.
 */
export class CorporateService extends EventEmitter {
  /** incrémenté à chaque changement : le service de marché s'en sert pour invalider ses séries ajustées */
  version = 1;
  private news: NewsService | null = null;
  private documents: DocumentService | null = null;

  constructor(private readonly db: DB, private readonly market: MarketService) {
    super();
    market.attachCorporate(this);
  }

  attach(news?: NewsService, documents?: DocumentService): void {
    if (news) {
      this.news = news;
      news.on("news", () => this.ingestRecent());
    }
    if (documents) {
      this.documents = documents;
      documents.on("documents", () => this.ingestRecent());
    }
  }

  private bump(): void {
    this.version++;
    this.emit("change", this.version);
  }

  // ---------- Actions sur le capital ----------

  private actionView(r: ActionRow): CorporateActionView {
    return { id: r.id, symbol: r.symbol, name: INSTRUMENT_MAP.get(r.symbol)?.name ?? r.symbol, kind: r.kind, exDate: r.ex_date, ratio: r.ratio, status: r.status, source: r.source, note: r.note, updatedAt: r.updated_at };
  }

  actions(symbol?: string, includeSuspected = true): CorporateActionView[] {
    const rows = this.db
      .prepare(`SELECT * FROM corporate_actions WHERE (? IS NULL OR symbol = ?) ${includeSuspected ? "" : "AND status = 'confirmé'"} ORDER BY ex_date DESC`)
      .all(symbol ?? null, symbol ?? null) as ActionRow[];
    return rows.map((r) => this.actionView(r));
  }

  upsertAction(input: ActionInput, userId: number | null): CorporateActionView {
    const symbol = input.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) throw new Error("Valeur inconnue");
    const exDate = toDayTs(input.exDate);
    if (exDate == null) throw new Error("Date d'effet invalide");
    if (!(input.ratio > 0) || (input.kind !== "bonus" && input.ratio < 2)) throw new Error("Rapport invalide");
    this.db
      .prepare(
        `INSERT INTO corporate_actions(symbol, kind, ex_date, ratio, status, source, note, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(symbol, kind, ex_date) DO UPDATE SET ratio=excluded.ratio, status=excluded.status, source=excluded.source, note=COALESCE(excluded.note, corporate_actions.note), updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      )
      .run(symbol, input.kind, exDate, input.ratio, input.status ?? "confirmé", input.source ?? (userId ? "analyste" : "import"), input.note ?? null, userId, Date.now());
    this.bump();
    return this.actionView(this.db.prepare("SELECT * FROM corporate_actions WHERE symbol = ? AND kind = ? AND ex_date = ?").get(symbol, input.kind, exDate) as ActionRow);
  }

  confirmAction(id: number, userId: number | null): CorporateActionView {
    const r = this.db.prepare("SELECT * FROM corporate_actions WHERE id = ?").get(id) as ActionRow | undefined;
    if (!r) throw new Error("Opération inconnue");
    this.db.prepare("UPDATE corporate_actions SET status = 'confirmé', source = 'analyste', updated_by = ?, updated_at = ? WHERE id = ?").run(userId, Date.now(), id);
    this.bump();
    return this.actionView({ ...r, status: "confirmé", source: "analyste" });
  }

  removeAction(id: number): void {
    const n = this.db.prepare("DELETE FROM corporate_actions WHERE id = ?").run(id).changes;
    if (n) this.bump();
  }

  /** Détecte les fractionnements probables dans l'historique brut et les enregistre comme « suspectés ». */
  detect(): { inserted: number; suspected: CorporateActionView[] } {
    const ins = this.db.prepare("INSERT OR IGNORE INTO corporate_actions(symbol, kind, ex_date, ratio, status, source, note, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
    let inserted = 0;
    const tx = this.db.transaction(() => {
      for (const inst of INSTRUMENTS) {
        const candles = this.market.history(inst.symbol, 5000, false);
        for (const s of detectSplits(inst.symbol, candles)) {
          inserted += ins.run(s.symbol, s.kind, s.exDate, s.ratio, "suspecté", "détection", `Clôture ${s.closeBefore} → ${s.closeAfter} (écart ${(s.deviation * 100).toFixed(1)} % du rapport ${s.ratio}). À confirmer avec l'avis officiel.`, null, Date.now()).changes;
        }
      }
    });
    tx();
    if (inserted) this.bump();
    return { inserted, suspected: this.actions(undefined, true).filter((a) => a.status === "suspecté") };
  }

  // ---------- Dividendes ----------

  private dividendView(r: DividendRow): DividendView {
    const netEstimated = r.net ?? (r.gross != null ? Math.round(r.gross * (1 - DIVIDEND_WITHHOLDING) * 100) / 100 : null);
    return { id: r.id, symbol: r.symbol, name: INSTRUMENT_MAP.get(r.symbol)?.name ?? r.symbol, fiscalYear: r.fiscal_year, gross: r.gross, net: r.net, netEstimated, exDate: r.ex_date, paymentDate: r.payment_date, agmDate: r.agm_date, status: r.status, source: r.source, url: r.url, note: r.note, updatedAt: r.updated_at };
  }

  dividends(symbol?: string): DividendView[] {
    const rows = this.db.prepare("SELECT * FROM dividends WHERE (? IS NULL OR symbol = ?) ORDER BY fiscal_year DESC, symbol").all(symbol ?? null, symbol ?? null) as DividendRow[];
    return rows.map((r) => this.dividendView(r));
  }

  /**
   * Insertion ou mise à jour partielle (les champs absents sont conservés). Une source automatique
   * ne remplace jamais une saisie d'analyste ni un import ; elle complète seulement les champs vides
   * et fait progresser le statut (proposé → approuvé → payé).
   */
  upsertDividend(input: DividendInput, userId: number | null): DividendView {
    const symbol = input.symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(symbol)) throw new Error("Valeur inconnue");
    if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1998 || input.fiscalYear > 2100) throw new Error("Exercice invalide");
    const source = input.source ?? (userId ? "analyste" : "import");
    const cur = this.db.prepare("SELECT * FROM dividends WHERE symbol = ? AND fiscal_year = ?").get(symbol, input.fiscalYear) as DividendRow | undefined;
    const auto = SOURCE_RANK(source) < 2;
    const weaker = cur ? SOURCE_RANK(source) < SOURCE_RANK(cur.source) : false;
    const pick = <T>(incoming: T | undefined, existing: T | null): T | null => {
      if (incoming === undefined) return existing;
      if (weaker && existing != null) return existing;
      return incoming;
    };
    const gross = pick(input.gross, cur?.gross ?? null);
    const net = pick(input.net, cur?.net ?? null);
    if (gross == null && net == null) throw new Error("Montant du dividende manquant");
    const exDate = pick(input.exDate === undefined ? undefined : toDayTs(input.exDate), cur?.ex_date ?? null);
    const paymentDate = pick(input.paymentDate === undefined ? undefined : toDayTs(input.paymentDate), cur?.payment_date ?? null);
    const agmDate = pick(input.agmDate === undefined ? undefined : toDayTs(input.agmDate), cur?.agm_date ?? null);
    let status: DividendStatus = input.status ?? cur?.status ?? "proposé";
    if (cur && STATUS_RANK[status] < STATUS_RANK[cur.status] && (auto || weaker)) status = cur.status;
    const keepSource = cur && weaker ? cur.source : source;
    this.db
      .prepare(
        `INSERT INTO dividends(symbol, fiscal_year, gross, net, ex_date, payment_date, agm_date, status, source, url, note, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(symbol, fiscal_year) DO UPDATE SET gross=excluded.gross, net=excluded.net, ex_date=excluded.ex_date, payment_date=excluded.payment_date, agm_date=excluded.agm_date, status=excluded.status, source=excluded.source, url=COALESCE(excluded.url, dividends.url), note=COALESCE(excluded.note, dividends.note), updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      )
      .run(symbol, input.fiscalYear, gross, net, exDate, paymentDate, agmDate, status, keepSource, input.url ?? null, input.note ?? null, userId, Date.now());
    this.bump();
    return this.dividendView(this.db.prepare("SELECT * FROM dividends WHERE symbol = ? AND fiscal_year = ?").get(symbol, input.fiscalYear) as DividendRow);
  }

  removeDividend(id: number): void {
    const n = this.db.prepare("DELETE FROM dividends WHERE id = ?").run(id).changes;
    if (n) this.bump();
  }

  /**
   * Import en bloc : une ligne par dividende, colonnes séparées par « ; » ou tabulation :
   * symbole ; exercice ; brut ; net ; détachement ; paiement ; assemblée ; statut ; source.
   * Les dates acceptent AAAA-MM-JJ ou JJ/MM/AAAA ; les montants la virgule décimale.
   */
  importDividends(text: string, userId: number | null): { imported: DividendView[]; rejected: string[] } {
    const imported: DividendView[] = [];
    const rejected: string[] = [];
    const num = (s: string | undefined) => {
      if (!s || !s.trim()) return null;
      const n = Number(s.replace(/[  ]/g, "").replace(",", "."));
      return Number.isFinite(n) ? n : null;
    };
    const date = (s: string | undefined) => {
      if (!s || !s.trim()) return null;
      const fr = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (fr) return Date.UTC(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]));
      return toDayTs(s.trim());
    };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^symbole/i.test(line)) continue;
      const c = line.split(/[;\t]/).map((x) => x.trim());
      try {
        const status = (c[7]?.toLowerCase() as DividendStatus) || undefined;
        if (status && !(status in STATUS_RANK)) throw new Error("statut");
        imported.push(this.upsertDividend({ symbol: c[0], fiscalYear: Number(c[1]), gross: num(c[2]), net: num(c[3]), exDate: date(c[4]), paymentDate: date(c[5]), agmDate: date(c[6]), status, source: c[8] || "import" }, userId));
      } catch {
        rejected.push(line);
      }
    }
    return { imported, rejected };
  }

  /** Lecture automatique d'un avis (actualité ou document) : enregistre un dividende si un montant est trouvé. */
  ingestText(symbol: string, text: string, url: string | null, source: string): DividendView | null {
    const sym = symbol.toUpperCase();
    if (!INSTRUMENT_MAP.has(sym)) return null;
    const n = parseDividendNotice(text);
    if (n.gross == null && n.net == null) return null;
    const fiscalYear = n.fiscalYear ?? new Date().getUTCFullYear() - 1;
    try {
      return this.upsertDividend({ symbol: sym, fiscalYear, gross: n.gross, net: n.net, exDate: n.exDate, paymentDate: n.paymentDate, agmDate: n.agmDate, status: n.status ?? undefined, source: `auto · ${source}`, url }, null);
    } catch {
      return null;
    }
  }

  /** Parcourt l'actualité et les documents récents mentionnant un dividende. */
  ingestRecent(): number {
    let n = 0;
    const since = Date.now() - 120 * DAY;
    for (const item of this.news?.latest(300) ?? []) {
      if (item.published_at < since || !/dividende/i.test(`${item.title} ${item.summary ?? ""}`)) continue;
      for (const sym of item.symbols) if (this.ingestText(sym, `${item.title}. ${item.summary ?? ""}`, item.url, item.source)) n++;
    }
    for (const d of this.documents?.list({ kind: "dividende", limit: 200 }) ?? []) {
      if (this.ingestText(d.symbol, `${d.title}. ${d.summary ?? ""}`, d.url, d.source)) n++;
    }
    return n;
  }

  /**
   * Dividendes publiés par Sika Finance (page « dividendes ») : historique par exercice (montants
   * nets) et détachements à venir. Source automatique : complète sans écraser les saisies.
   */
  async refreshFromSika(fetchImpl: typeof fetch = fetch, base = process.env.SIKA_BASE ?? "https://www.sikafinance.com"): Promise<{ history: number; upcoming: number }> {
    const html = await politeText(`${base}/marches/dividendes`, { fetchImpl });
    const { history, upcoming } = parseSikaDividends(html);
    let h = 0;
    let u = 0;
    for (const c of history) {
      if (!INSTRUMENT_MAP.has(c.symbol)) continue;
      for (const y of c.byYear) {
        try { this.upsertDividend({ symbol: c.symbol, fiscalYear: y.year, net: y.amount, source: "auto · Sika Finance", url: `${base}/marches/dividendes` }, null); h++; } catch { /* ligne incohérente */ }
      }
    }
    for (const up of upcoming) {
      if (!up.symbol || !INSTRUMENT_MAP.has(up.symbol) || up.amount == null) continue;
      const fiscalYear = new Date(up.exDate ?? Date.now()).getUTCFullYear() - 1;
      try { this.upsertDividend({ symbol: up.symbol, fiscalYear, net: up.amount, exDate: up.exDate, status: "approuvé", source: "auto · Sika Finance", url: `${base}/marches/dividendes` }, null); u++; } catch { /* idem */ }
    }
    this.lastSikaRun = { at: Date.now(), history: h, upcoming: u };
    return { history: h, upcoming: u };
  }

  lastSikaRun: { at: number; history: number; upcoming: number } | null = null;

  // ---------- Lectures pour les autres services ----------

  /** Ajustements à appliquer aux séries : opérations confirmées et dividendes datés. */
  adjustments(symbol: string): CorporateAction[] {
    const out: CorporateAction[] = [];
    for (const a of this.db.prepare("SELECT * FROM corporate_actions WHERE symbol = ? AND status = 'confirmé'").all(symbol) as ActionRow[]) out.push({ symbol, kind: a.kind, exDate: a.ex_date, ratio: a.ratio });
    for (const d of this.db.prepare("SELECT * FROM dividends WHERE symbol = ? AND ex_date IS NOT NULL").all(symbol) as DividendRow[]) {
      const v = this.dividendView(d);
      if (v.netEstimated != null && v.netEstimated > 0) out.push({ symbol, kind: "dividend", exDate: d.ex_date!, amount: v.netEstimated });
    }
    return out.sort((a, b) => a.exDate - b.exDate);
  }

  dividendInfo(symbol: string, price: number): DividendInfo {
    const list = this.dividends(symbol.toUpperCase());
    const today = toDayTs(Date.now())!;
    const last = list.find((d) => d.netEstimated != null && (d.exDate == null || d.exDate <= today)) ?? null;
    const upcoming = list.filter((d) => d.exDate != null && d.exDate > today && d.netEstimated != null).sort((a, b) => a.exDate! - b.exDate!)[0] ?? null;
    return {
      last,
      yieldPct: last && price > 0 ? Math.round((last.netEstimated! / price) * 1000) / 10 : null,
      next: upcoming ? { exDate: upcoming.exDate!, amount: upcoming.netEstimated!, fiscalYear: upcoming.fiscalYear, status: upcoming.status } : null,
      years: list.length,
    };
  }

  /** Rendement net réel (%) d'après le dernier dividende connu, sinon null. */
  yieldFor(symbol: string, price: number): number | null {
    return this.dividendInfo(symbol, price).yieldPct;
  }

  /**
   * Calendrier : les dates réelles de détachement et de paiement remplacent les dates indicatives
   * du calendrier construit par habitude de publication.
   */
  calendar(year: number): MarketEvent[] {
    const base = buildEventCalendar(year);
    const real = this.db.prepare("SELECT * FROM dividends WHERE ex_date IS NOT NULL OR payment_date IS NOT NULL OR agm_date IS NOT NULL").all() as DividendRow[];
    const replaced = new Set<string>();
    const extra: MarketEvent[] = [];
    for (const r of real) {
      const v = this.dividendView(r);
      const amount = v.netEstimated != null ? `${v.netEstimated.toLocaleString("fr-FR")} FCFA net` : "montant à préciser";
      const inYear = (ts: number | null) => ts != null && new Date(ts).getUTCFullYear() === year;
      if (inYear(r.ex_date)) {
        replaced.add(`${r.symbol}-div-${year}`);
        extra.push({ id: `${r.symbol}-div-real-${r.fiscal_year}`, symbol: r.symbol, kind: "dividend", title: `${v.name} : détachement du dividende ${r.fiscal_year}`, date: r.ex_date!, detail: `Dividende ${amount} par action (${r.status}, source : ${r.source}).`, indicative: false });
      }
      if (inYear(r.payment_date)) extra.push({ id: `${r.symbol}-divpay-${r.fiscal_year}`, symbol: r.symbol, kind: "dividend", title: `${v.name} : mise en paiement du dividende ${r.fiscal_year}`, date: r.payment_date!, detail: `Dividende ${amount} par action.`, indicative: false });
      if (inYear(r.agm_date)) {
        replaced.add(`${r.symbol}-agm-${year}`);
        extra.push({ id: `${r.symbol}-agm-real-${r.fiscal_year}`, symbol: r.symbol, kind: "agm", title: `${v.name} : assemblée générale (exercice ${r.fiscal_year})`, date: r.agm_date!, detail: "Date publiée par la société.", indicative: false });
      }
    }
    return [...base.filter((e) => !replaced.has(e.id)), ...extra].sort((a, b) => a.date - b.date);
  }

  status(): { actions: number; suspected: number; dividends: number; symbolsWithDividends: number; version: number } {
    const a = this.db.prepare("SELECT COUNT(*) AS n, SUM(status = 'suspecté') AS s FROM corporate_actions").get() as { n: number; s: number | null };
    const d = this.db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT symbol) AS s FROM dividends").get() as { n: number; s: number };
    return { actions: a.n, suspected: a.s ?? 0, dividends: d.n, symbolsWithDividends: d.s, version: this.version };
  }
}
