/**
 * « Aujourd'hui » : l'écran d'accueil en trois blocs, pour une personne qui veut agir vite.
 *
 *  - À faire : les ordres à passer chez la SGI, en phrases simples, dérivés du moteur court terme
 *    (achats des lignes ouvertes non encore passés, ventes des lignes soldées par une barrière ou la
 *    protection, échéances imminentes), avec une case « c'est fait » (rapprochement). Une ligne
 *    n'apparaît que si elle demande une action aujourd'hui.
 *  - Où j'en suis : capital des deux poches (court terme, long terme), gain ou perte du mois, jauge
 *    de protection.
 *  - Santé du moteur : un feu vert, orange ou rouge et une phrase. Vert : la dernière mesure bat
 *    l'indice avec une perte maximale moindre et les données sont à jour. Orange : pas encore
 *    mesuré, modèle ancien, données à vérifier, marché en stress. Rouge : le moteur ne bat pas
 *    l'indice ou le portefeuille réel sous-performe depuis trois mois : rester en liquidités.
 */
import type { DB } from "../db/index.js";
import type { MarketService } from "./market.js";
import type { ShortTermService, ShortTermPortfolio } from "./shortterm.js";
import type { HoldingsService } from "./holdings.js";
import type { DataQualityService } from "./dataquality.js";

export type ActionKind = "acheter" | "vendre" | "échéance" | "info";

export interface TodayAction {
  id: string;
  kind: ActionKind;
  portfolioId: number | null;
  positionId: number | null;
  symbol: string | null;
  name: string | null;
  quantity: number | null;
  price: number | null;
  /** la phrase à exécuter */
  text: string;
  /** pourquoi, en une phrase */
  why: string;
  /** détail replié : objectif, seuil, échéance, probabilité */
  details: string[];
  done: boolean;
  since: number;
  urgent: boolean;
  link: string | null;
}

export interface TodayCapital {
  shortTerm: { portfolioId: number; capital: number; value: number; monthPct: number | null; monthFcfa: number | null; sincePct: number; alphaPct: number; exposurePct: number; exposureCapPct: number; floorDistancePct: number; open: number; status: "actif" | "clos" } | null;
  longTerm: { total: number; invested: number; cash: number; pnlPct: number | null; dividendYieldPct: number; lines: number } | null;
  total: number;
}

export interface TodayHealth {
  light: "vert" | "orange" | "rouge";
  title: string;
  reasons: string[];
  regime: { label: string; multiplier: number } | null;
  measuredAt: number | null;
  modelAt: number | null;
  dataQualityScore: number | null;
  lastSession: number | null;
}

export interface TodayView {
  date: number;
  actions: TodayAction[];
  capital: TodayCapital;
  health: TodayHealth;
  nextReview: string;
}

const DAY = 86_400_000;
const r0 = (v: number) => Math.round(v);
const r2 = (v: number) => Math.round(v * 100) / 100;
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const fmtN = (v: number) => Math.round(v).toLocaleString("fr-FR");

export class TodayService {
  private holdings: HoldingsService | null = null;
  private dataQuality: DataQualityService | null = null;

  constructor(private readonly db: DB, private readonly market: MarketService, private readonly shortTerm: ShortTermService) {}

  attach(holdings: HoldingsService | null, dataQuality: DataQualityService | null): void {
    this.holdings = holdings;
    this.dataQuality = dataQuality;
  }

  /** Rapprochement : l'ordre d'achat ou de vente d'une position a été passé chez la SGI. */
  confirm(userId: number, positionId: number, kind: "achat" | "vente", done = true): boolean {
    const row = this.db.prepare("SELECT p.id FROM st_positions p JOIN st_portfolios f ON f.id = p.portfolio_id WHERE p.id = ? AND f.user_id = ?").get(positionId, userId) as { id: number } | undefined;
    if (!row) return false;
    const col = kind === "achat" ? "entry_confirmed_at" : "exit_confirmed_at";
    this.db.prepare(`UPDATE st_positions SET ${col} = ? WHERE id = ?`).run(done ? Date.now() : null, positionId);
    return true;
  }

  private actionsFor(p: ShortTermPortfolio): TodayAction[] {
    const confirmed = new Map((this.db.prepare("SELECT id, entry_confirmed_at, exit_confirmed_at FROM st_positions WHERE portfolio_id = ?").all(p.id) as { id: number; entry_confirmed_at: number | null; exit_confirmed_at: number | null }[]).map((r) => [r.id, r]));
    const out: TodayAction[] = [];
    const now = Date.now();
    for (const pos of p.positions) {
      const c = confirmed.get(pos.id);
      const name = pos.name;
      if (pos.exitTs == null) {
        const details = [`Objectif ${fmtN(pos.targetPrice)} FCFA (+${r2((pos.targetPrice / pos.entryPrice - 1) * 100)} %)`, `Seuil ${fmtN(pos.stopPrice)} FCFA (${r2((pos.stopPrice / pos.entryPrice - 1) * 100)} %)`, `Échéance ${fmtDate(pos.deadlineTs)}`, `Probabilité de succès apprise ${Math.round(pos.prob * 100)} %`, `Poids ${pos.weightPct} % du capital`];
        if (!c?.entry_confirmed_at) {
          out.push({ id: `buy-${pos.id}`, kind: "acheter", portfolioId: p.id, positionId: pos.id, symbol: pos.symbol, name, quantity: pos.quantity, price: pos.entryPrice, text: `Acheter ${fmtN(pos.quantity)} ${pos.symbol} (${name}) à ${fmtN(pos.entryPrice)} FCFA au plus.`, why: `Placer aussitôt la vente à ${fmtN(pos.targetPrice)} (objectif) et à ${fmtN(pos.stopPrice)} (seuil) ; vendre quoi qu'il arrive le ${fmtDate(pos.deadlineTs)}.`, details, done: false, since: pos.entryTs, urgent: now - pos.entryTs > 2 * DAY, link: "/court-terme" });
        } else if (pos.deadlineTs - now <= 2 * DAY) {
          out.push({ id: `deadline-${pos.id}`, kind: "échéance", portfolioId: p.id, positionId: pos.id, symbol: pos.symbol, name, quantity: pos.quantity, price: pos.price, text: `Vendre ${fmtN(pos.quantity)} ${pos.symbol} (${name}) au marché avant le ${fmtDate(pos.deadlineTs)}.`, why: `L'échéance de la position arrive : le moteur ne garde jamais une ligne au-delà de sa durée prévue.`, details, done: false, since: pos.deadlineTs - 2 * DAY, urgent: true, link: "/court-terme" });
        }
      } else if (!c?.exit_confirmed_at) {
        const reason = pos.exitReason === "objectif" ? "l'objectif a été touché" : pos.exitReason === "seuil" ? "le seuil de perte a été touché" : pos.exitReason === "échéance" ? "l'échéance est arrivée" : pos.exitReason === "protection" ? "la protection du capital a réduit l'exposition" : "clôture décidée";
        out.push({ id: `sell-${pos.id}`, kind: "vendre", portfolioId: p.id, positionId: pos.id, symbol: pos.symbol, name, quantity: pos.quantity, price: pos.exitPrice, text: `Vendre ${fmtN(pos.quantity)} ${pos.symbol} (${name}) au marché${pos.exitPrice ? `, autour de ${fmtN(pos.exitPrice)} FCFA` : ""}.`, why: `Le ${fmtDate(pos.exitTs)}, ${reason}${pos.exitReason === "seuil" ? ". La discipline du seuil ne se négocie pas" : ""}.`, details: [`Entrée à ${fmtN(pos.entryPrice)} le ${fmtDate(pos.entryTs)}`, `Résultat de la ligne ${pos.returnPct > 0 ? "+" : ""}${pos.returnPct} %`], done: false, since: pos.exitTs, urgent: pos.exitReason === "seuil" || pos.exitReason === "protection" || now - pos.exitTs > DAY, link: "/court-terme" });
      }
    }
    return out;
  }

  private health(userId: number, st: ShortTermPortfolio | null): TodayHealth {
    const status = this.shortTerm.status();
    const reasons: string[] = [];
    let light: TodayHealth["light"] = "vert";
    const worse = (l: TodayHealth["light"]) => { if (l === "rouge" || (l === "orange" && light === "vert")) light = l; };
    const bt = status.latestBacktest;
    const lastSession = this.market.indexHistory(1)[0]?.ts ?? null;
    if (!bt) { worse("orange"); reasons.push("Le moteur n'a pas encore été mesuré hors échantillon : lancez « Mesurer le moteur complet » (page Court terme, mode Expert)."); }
    else if (bt.complete.totalReturnPct <= bt.index.totalReturnPct) { worse("rouge"); reasons.push(`Sur la dernière mesure, le moteur fait ${bt.complete.totalReturnPct > 0 ? "+" : ""}${bt.complete.totalReturnPct.toFixed(1)} % contre ${bt.index.totalReturnPct > 0 ? "+" : ""}${bt.index.totalReturnPct.toFixed(1)} % pour l'indice : n'engagez pas de capital, restez en liquidités.`); }
    else if (bt.complete.maxDrawdownPct < bt.index.maxDrawdownPct) { worse("orange"); reasons.push(`Le moteur bat l'indice (${bt.complete.totalReturnPct > 0 ? "+" : ""}${bt.complete.totalReturnPct.toFixed(1)} % contre ${bt.index.totalReturnPct > 0 ? "+" : ""}${bt.index.totalReturnPct.toFixed(1)} %) mais avec une perte maximale plus forte (${bt.complete.maxDrawdownPct} % contre ${bt.index.maxDrawdownPct} %).`); }
    else reasons.push(`Le moteur bat l'indice sur la dernière mesure (${bt.complete.totalReturnPct > 0 ? "+" : ""}${bt.complete.totalReturnPct.toFixed(1)} % contre ${bt.index.totalReturnPct > 0 ? "+" : ""}${bt.index.totalReturnPct.toFixed(1)} %) avec une perte maximale moindre.`);
    if (bt && Date.now() - bt.createdAt > 45 * DAY) { worse("orange"); reasons.push(`La dernière mesure date du ${fmtDate(bt.createdAt)} : à refaire chaque mois.`); }
    if (!status.model) { worse("orange"); reasons.push("Le modèle de probabilité n'est pas encore entraîné (il se lance seul après le démarrage, puis chaque semaine)."); }
    else if (Date.now() - status.model.createdAt > 14 * DAY) { worse("orange"); reasons.push(`Le modèle de probabilité date du ${fmtDate(status.model.createdAt)} : plus de deux semaines.`); }
    if (st && st.stats.days >= 90 && st.stats.alphaPct < -3) { worse("rouge"); reasons.push(`Votre poche court terme fait ${st.stats.alphaPct.toFixed(1)} points de moins que l'indice depuis ${st.stats.days} jours : réduisez-la de moitié en attendant la prochaine mesure.`); }
    const q = this.dataQuality?.status().lastRun ?? null;
    if (q && (q.errors > 0 || q.score < 70)) { worse("orange"); reasons.push(`Qualité des données : ${q.score}/100${q.errors ? `, ${q.errors} erreur(s)` : ""} (page Qualité & risque, mode Expert).`); }
    if (lastSession && Date.now() - lastSession > 7 * DAY) { worse("orange"); reasons.push(`Dernière séance connue le ${fmtDate(lastSession)} : les cours ne sont pas à jour.`); }
    if (status.regime.key === "stress") { worse("orange"); reasons.push(`Marché en stress (${status.regime.reasons.join(", ")}) : le moteur réduit l'exposition à un quart.`); }
    if (status.training) reasons.push(`Entraînement du modèle en cours (${status.training.done}/${status.training.total}).`);
    if (status.backtesting) reasons.push(`Mesure en cours (${status.backtesting.done}/${status.backtesting.total}).`);
    const title = light === "vert" ? "Le moteur est fiable et à jour : vous pouvez suivre ses ordres." : light === "orange" ? "Le moteur fonctionne, avec un point à surveiller." : "Le moteur n'est pas assez bon pour engager du capital.";
    return { light, title, reasons, regime: { label: status.regime.label, multiplier: status.regime.multiplier }, measuredAt: bt?.createdAt ?? null, modelAt: status.model?.createdAt ?? null, dataQualityScore: q?.score ?? null, lastSession };
  }

  view(userId: number): TodayView {
    const now = Date.now();
    const ports = this.shortTerm.list(userId);
    const active = ports.find((p) => p.status === "actif") ?? null;
    const st = active ? this.shortTerm.view(userId, active.id) : null;
    const actions: TodayAction[] = st ? this.actionsFor(st) : [];
    // sans portefeuille actif : proposer le panier du jour si le moteur est fiable
    const health = this.health(userId, st);
    if (!st && health.light !== "rouge") {
      const c = this.shortTerm.candidates();
      const n = c.items.filter((x) => x.selected).length;
      if (n) actions.push({ id: "publish", kind: "info", portfolioId: null, positionId: null, symbol: null, name: null, quantity: null, price: null, text: `Le moteur propose un panier de ${n} ligne(s) (${100 - c.cashPct} % investis) : publiez-le pour démarrer la poche court terme.`, why: `Régime ${c.protection.regime.label.toLowerCase()} : ${Math.round(c.protection.exposure * 100)} % du capital au plus sont investis, le reste attend en liquidités.`, details: c.items.filter((x) => x.selected).map((x) => `${x.symbol} ${x.weightPct} % · probabilité ${Math.round(x.prob * 100)} % · objectif ${fmtN(x.targetPrice)} · seuil ${fmtN(x.stopPrice)}`), done: false, since: c.at, urgent: false, link: "/court-terme" });
    }
    actions.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.since - b.since);
    // capital
    let shortTerm: TodayCapital["shortTerm"] = null;
    if (st) {
      const monthAgo = now - 30 * DAY;
      const ref = st.series.filter((s) => s.time <= monthAgo).pop() ?? st.series[0];
      const value = st.stats.value;
      const monthPct = ref && ref.value > 0 && st.series.length > 1 ? r2((value / ref.value - 1) * 100) : null;
      const prot = st.protection;
      shortTerm = { portfolioId: st.id, capital: st.capital, value, monthPct, monthFcfa: ref && st.series.length > 1 ? r0(value - ref.value) : null, sincePct: st.stats.returnNetPct, alphaPct: st.stats.alphaPct, exposurePct: value > 0 ? Math.round(((value - st.cash) / value) * 100) : 0, exposureCapPct: prot ? Math.round(prot.exposure * 100) : 100, floorDistancePct: prot && value > 0 ? r2(((value - prot.state.floor) / value) * 100) : 0, open: st.stats.open, status: st.status };
    }
    let longTerm: TodayCapital["longTerm"] = null;
    if (this.holdings) {
      try {
        const h = this.holdings.get(userId);
        if (h.positions.length || h.cash > 0) {
          const a = this.holdings.analyze(userId);
          longTerm = { total: a.totals.total, invested: a.totals.invested, cash: a.totals.cash, pnlPct: a.totals.pnlPct, dividendYieldPct: a.totals.dividendYieldPct, lines: a.totals.lines };
        }
      } catch {
        longTerm = null;
      }
    }
    const capital: TodayCapital = { shortTerm, longTerm, total: r0((shortTerm?.value ?? 0) + (longTerm?.total ?? 0)) };
    const nextReview = "Le moteur revoit les barrières chaque jour ouvré après la clôture (16 h GMT) ; une seule liste d'ordres par jour.";
    return { date: now, actions, capital, health, nextReview };
  }
}
