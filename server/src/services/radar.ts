import { EventEmitter } from "node:events";
import type { DB } from "../db/index.js";
import { INSTRUMENT_MAP } from "../data/instruments.js";
import { buildEventCalendar } from "../data/events.js";
import type { BondService } from "./bonds.js";
import type { DocumentService } from "./documents.js";
import type { NewsService } from "./news.js";
import type { CorporateService } from "./corporate.js";

export type RadarKind = "introduction" | "emission_obligataire" | "offre_publique" | "dividende" | "resultats" | "assemblee" | "suspension" | "nouvelle_obligation" | "augmentation_capital" | "calendrier";

export const RADAR_KIND_LABEL: Record<RadarKind, string> = {
  introduction: "Introduction en bourse",
  emission_obligataire: "Émission obligataire",
  offre_publique: "Offre publique",
  dividende: "Dividende",
  resultats: "Résultats",
  assemblee: "Assemblée générale",
  suspension: "Suspension",
  nouvelle_obligation: "Nouvelle obligation cotée",
  augmentation_capital: "Augmentation de capital",
  calendrier: "Échéance à venir",
};

export interface RadarEvent {
  id: number;
  kind: RadarKind;
  symbol: string | null;
  title: string;
  detail: string | null;
  url: string | null;
  source: string;
  date: number;
  created_at: number;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Classe un titre d'actualité ou de document en événement de place, ou null s'il n'en est pas un. */
export function classifyRadar(title: string): RadarKind | null {
  const t = norm(title);
  if (/suspen/.test(t)) return "suspension";
  if (/introduction en bourse|\bipo\b|premiere cotation|admission a la cote|entree en bourse/.test(t)) return "introduction";
  if (/offre publique|\bopa\b|\bope\b|\bopr\b|retrait de la cote/.test(t)) return "offre_publique";
  if (/augmentation de capital|droits de souscription|attribution gratuite/.test(t)) return "augmentation_capital";
  if (/emprunt obligataire|emission obligataire|appel public a l'epargne|sukuk|obligations? \d|\bape\b/.test(t)) return "emission_obligataire";
  if (/dividende|mise en paiement|detachement/.test(t)) return "dividende";
  if (/assemblee generale|\bago\b|\bage\b|convocation/.test(t)) return "assemblee";
  if (/resultat|chiffre d'affaires|etats financiers|comptes annuels|rapport annuel|semestriel|trimestriel/.test(t)) return "resultats";
  return null;
}

/**
 * Radar des événements de la place : introductions, émissions, offres publiques, dividendes,
 * résultats, assemblées, suspensions, nouvelles obligations cotées et échéances du calendrier,
 * détectés dans l'actualité, les documents collectés et la cote obligataire, conservés en base.
 */
export class RadarService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private lastScan: { at: number; inserted: number } | null = null;
  private corporate: CorporateService | null = null;

  /** Dividendes réels : le calendrier du radar utilise les dates publiées. */
  attachCorporate(c: CorporateService): void {
    this.corporate = c;
    c.on("change", () => void this.scan());
  }

  constructor(
    private readonly db: DB,
    private readonly news: NewsService | null,
    private readonly documents: DocumentService | null,
    private readonly bonds: BondService | null,
  ) {
    super();
    news?.on("news", () => void this.scan());
    documents?.on("documents", () => void this.scan());
    bonds?.on("bonds", () => void this.scan());
  }

  start(intervalMs = 30 * 60_000): void {
    setTimeout(() => this.scan(), 30_000);
    this.timer = setInterval(() => this.scan(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Événement signalé par une autre lecture (modèle de langage) ; dédoublonné comme les autres. */
  record(e: Omit<RadarEvent, "id" | "created_at">): boolean {
    return this.insert(e) > 0;
  }

  private insert(e: Omit<RadarEvent, "id" | "created_at">): number {
    const key = `${e.kind}|${e.symbol ?? ""}|${norm(e.title).slice(0, 120)}`;
    return this.db
      .prepare("INSERT OR IGNORE INTO radar_events(kind, symbol, title, detail, url, source, date, dedupe_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(e.kind, e.symbol, e.title, e.detail, e.url, e.source, e.date, key, Date.now()).changes;
  }

  /** Balayage des sources : idempotent (dédoublonnage par type, société et titre). */
  scan(): number {
    let n = 0;
    const tx = this.db.transaction(() => {
      for (const item of this.news?.latest(300) ?? []) {
        const kind = classifyRadar(item.title);
        if (!kind) continue;
        const symbol = item.symbols[0] ?? null;
        n += this.insert({ kind, symbol, title: item.title, detail: item.summary, url: item.url, source: item.source, date: item.published_at });
      }
      for (const d of this.documents?.list({ limit: 500 }) ?? []) {
        const kind = classifyRadar(d.title) ?? (d.kind === "dividende" ? "dividende" : d.kind === "assemblee" ? "assemblee" : d.kind === "resultats" || d.kind === "etats_financiers" || d.kind === "rapport_annuel" ? "resultats" : d.kind === "note_information" ? "emission_obligataire" : null);
        if (!kind) continue;
        n += this.insert({ kind, symbol: d.symbol, title: `${INSTRUMENT_MAP.get(d.symbol)?.name ?? d.symbol} : ${d.title}`, detail: d.period ? `Période ${d.period}` : null, url: d.url, source: d.source, date: d.published_at ?? d.fetched_at });
      }
      for (const b of this.bonds?.list() ?? []) {
        const issued = Date.parse(b.issueDate);
        if (Number.isFinite(issued) && Date.now() - issued < 400 * 86_400_000) n += this.insert({ kind: "nouvelle_obligation", symbol: null, title: `${b.code} · ${b.name}`, detail: `${b.issuer}, coupon ${b.couponPct} %, échéance ${b.maturityDate.slice(0, 4)}`, url: null, source: "cote BRVM", date: issued });
      }
      const now = Date.now();
      const year = new Date(now).getUTCFullYear();
      const cal = (y: number) => this.corporate?.calendar(y) ?? buildEventCalendar(y);
      for (const ev of [...cal(year), ...cal(year + 1)]) {
        if (ev.date < now || ev.date > now + 30 * 86_400_000) continue;
        n += this.insert({ kind: "calendrier", symbol: ev.symbol, title: ev.title, detail: `${ev.detail}${ev.indicative ? " (date indicative)" : ""}`, url: null, source: "calendrier", date: ev.date });
      }
    });
    tx();
    this.lastScan = { at: Date.now(), inserted: n };
    if (n) this.emit("radar", n);
    return n;
  }

  list(opts: { kind?: RadarKind; symbol?: string; since?: number; limit?: number } = {}): RadarEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.kind) { where.push("kind = ?"); params.push(opts.kind); }
    if (opts.symbol) { where.push("symbol = ?"); params.push(opts.symbol.toUpperCase()); }
    if (opts.since) { where.push("date >= ?"); params.push(opts.since); }
    params.push(Math.min(500, opts.limit ?? 100));
    return this.db.prepare(`SELECT * FROM radar_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY date DESC, id DESC LIMIT ?`).all(...params) as RadarEvent[];
  }

  status() {
    const byKind = this.db.prepare("SELECT kind, COUNT(*) AS n FROM radar_events GROUP BY kind").all() as { kind: RadarKind; n: number }[];
    const recent = (this.db.prepare("SELECT COUNT(*) AS n FROM radar_events WHERE created_at >= ?").get(Date.now() - 48 * 3600_000) as { n: number }).n;
    return { byKind, recent48h: recent, lastScan: this.lastScan };
  }
}
