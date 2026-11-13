/**
 * Lecture des publications par modèle de langage.
 *
 * Le lecteur à règles (`engine/fundamentals.ts`) ne reconnaît que des formulations connues. Ici, le
 * texte complet d'une publication (communiqué de résultats, états financiers, rapport annuel, avis)
 * conservé dans `document_bodies` est soumis à Claude avec un schéma de sortie imposé : périodes
 * (chiffre d'affaires, résultat net, capitaux propres, actions, BPA, dividende, croissances) et
 * événements (dividende proposé, avertissement sur résultats, changement de direction, opération sur
 * le capital, assemblée). Les chiffres sont enregistrés dans les fondamentaux avec le statut « auto »
 * (jamais par-dessus une saisie d'analyste), les événements dans le radar.
 *
 * Garde-fous : clé absente = service désactivé (le lecteur à règles reste) ; budget quotidien de
 * documents (LLM_EXTRACT_DAILY_MAX) ; texte plafonné ; chaque appel journalisé avec ses jetons.
 * L'appel au modèle est injectable pour les tests (aucune requête réelle dans la suite de tests).
 */
import { EventEmitter } from "node:events";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import type { DB } from "../db/index.js";
import { INSTRUMENT_MAP, INSTRUMENTS } from "../data/instruments.js";
import type { FundamentalsService } from "./fundamentals.js";
import type { RadarService, RadarKind } from "./radar.js";

export const DEFAULT_LLM_MODEL = "claude-opus-5-5";
const DEFAULT_DAILY_MAX = 25;
const MAX_CHARS = 60_000;
const DAY = 86_400_000;

const PeriodSchema = z.object({
  period: z.string().describe("Période couverte : exercice annuel « 2025 », semestre « S1 2025 », trimestre « T3 2025 »"),
  periodEnd: z.string().nullable().describe("Fin de période au format AAAA-MM-JJ, null si inconnue"),
  revenue: z.number().nullable().describe("Chiffre d'affaires (ou produit net bancaire) en FCFA, montant complet"),
  netIncome: z.number().nullable().describe("Résultat net (part du groupe si consolidé) en FCFA"),
  equity: z.number().nullable().describe("Capitaux propres en FCFA"),
  shares: z.number().nullable().describe("Nombre d'actions composant le capital"),
  eps: z.number().nullable().describe("Bénéfice par action en FCFA"),
  dps: z.number().nullable().describe("Dividende brut par action en FCFA, proposé ou voté, au titre de la période"),
  revenueGrowthPct: z.number().nullable().describe("Variation du chiffre d'affaires sur un an, en %"),
  netIncomeGrowthPct: z.number().nullable().describe("Variation du résultat net sur un an, en %"),
});

const EVENT_KINDS = ["dividende", "resultats", "avertissement", "direction", "augmentation_capital", "assemblee", "offre_publique", "autre"] as const;

const EventSchema = z.object({
  kind: z.enum(EVENT_KINDS).describe("dividende proposé ou voté ; resultats publiés ; avertissement (baisse marquée, perte, alerte) ; direction (nomination ou départ d'un dirigeant) ; augmentation_capital (ou division, rachat) ; assemblee (convocation) ; offre_publique ; autre"),
  title: z.string().describe("Titre court en français, 120 caractères au plus"),
  detail: z.string().nullable().describe("Précision chiffrée ou datée, une phrase"),
  date: z.string().nullable().describe("Date de l'événement au format AAAA-MM-JJ si connue"),
});

export const ExtractionSchema = z.object({
  symbol: z.string().nullable().describe("Symbole BRVM de la société concernée s'il figure dans la liste fournie, sinon null"),
  company: z.string().nullable().describe("Nom de la société tel qu'il apparaît dans le texte"),
  documentKind: z.enum(["resultats", "etats_financiers", "rapport_annuel", "communique", "avis", "autre"]),
  publishedAt: z.string().nullable().describe("Date de publication au format AAAA-MM-JJ si elle figure dans le texte"),
  periods: z.array(PeriodSchema).describe("Une entrée par période dont au moins un montant est donné ; pas d'estimation"),
  events: z.array(EventSchema),
  summary: z.string().describe("Résumé en français, trois phrases au plus, pour un investisseur"),
  confidence: z.enum(["haute", "moyenne", "faible"]).describe("faible si les chiffres sont ambigus (unités, périmètre, période)"),
  warnings: z.array(z.string()).describe("Ambiguïtés rencontrées : unités, consolidé ou social, période incertaine"),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

export const SYSTEM_PROMPT = `Tu es un analyste financier spécialiste de la Bourse régionale des valeurs mobilières (BRVM, UEMOA). On te donne le texte d'une publication d'une société cotée (communiqué, états financiers, rapport annuel, avis). Extrais uniquement ce qui est écrit dans le texte, sans estimer ni compléter.

Règles :
- Montants en FCFA complets : « 1 650,2 milliards » devient 1650200000000 ; « 45 millions » devient 45000000. Si l'unité est ambiguë, mets le chiffre dans warnings et laisse null.
- Préfère les chiffres consolidés et la part du groupe quand les deux existent ; indique le périmètre retenu dans warnings si le texte donne les deux.
- Une période par exercice ou semestre ou trimestre mentionné avec des chiffres. Les comparatifs de l'année précédente donnent aussi une période (par exemple 2024 à côté de 2025) seulement si leurs montants sont explicites.
- Le dividende par action est brut, au titre de la période (exercice) et non à sa date de paiement.
- Les croissances sont celles énoncées par le texte ; sinon calcule-les seulement si les deux montants annuels sont présents.
- Les événements signalent ce qui compte pour un investisseur : dividende proposé ou voté, résultats publiés, avertissement (baisse marquée, perte, suspension), changement de direction, opération sur le capital, assemblée, offre publique.
- Le symbole est l'un de ceux de la liste fournie ; null si la société n'y figure pas.`;

export interface LlmCall {
  system: string;
  user: string;
}

export interface LlmReply {
  parsed: Extraction | null;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export type LlmCaller = (call: LlmCall) => Promise<LlmReply>;

export interface LlmExtractionRow {
  id: number;
  url: string | null;
  symbol: string | null;
  model: string;
  ts: number;
  status: "ok" | "vide" | "refus" | "erreur";
  result: Extraction | null;
  inputTokens: number;
  outputTokens: number;
  periodsSaved: number;
  eventsSaved: number;
  error: string | null;
}

export interface LlmStatus {
  enabled: boolean;
  reason: string | null;
  model: string;
  dailyMax: number;
  usedToday: number;
  bodies: number;
  pending: number;
  extractions: number;
  tokens: { input: number; output: number };
  lastRun: { at: number; processed: number; saved: number; failed: number } | null;
  running: boolean;
  recent: LlmExtractionRow[];
}

/** Appel réel : sortie structurée (schéma Zod), repli serveur activé, invite système mise en cache. */
export function anthropicCaller(apiKey: string, model: string): LlmCaller {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 180_000 });
  return async ({ system, user }) => {
    const r = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      output_config: { format: zodOutputFormat(ExtractionSchema), effort: "medium" },
    });
    return { parsed: (r.parsed_output as Extraction | null) ?? null, stopReason: String(r.stop_reason ?? ""), inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, model: r.model };
  };
}

const isoDay = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!m) return null;
  const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ts) ? ts : null;
};

const RADAR_KIND: Record<(typeof EVENT_KINDS)[number], RadarKind | null> = {
  dividende: "dividende",
  resultats: "resultats",
  avertissement: "resultats",
  direction: "assemblee",
  augmentation_capital: "augmentation_capital",
  assemblee: "assemblee",
  offre_publique: "offre_publique",
  autre: null,
};

export class LlmExtractService extends EventEmitter {
  private readonly model: string;
  private readonly dailyMax: number;
  private caller: LlmCaller | null;
  private disabledReason: string | null;
  private running = false;
  private lastRun: LlmStatus["lastRun"] = null;
  private radar: RadarService | null = null;

  constructor(private readonly db: DB, private readonly fundamentals: FundamentalsService, opts: { caller?: LlmCaller; apiKey?: string | null; model?: string; dailyMax?: number } = {}) {
    super();
    this.model = opts.model ?? process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL;
    const max = opts.dailyMax ?? Number(process.env.LLM_EXTRACT_DAILY_MAX ?? DEFAULT_DAILY_MAX);
    this.dailyMax = Number.isFinite(max) && max >= 0 ? max : DEFAULT_DAILY_MAX;
    const apiKey = opts.apiKey === undefined ? process.env.ANTHROPIC_API_KEY ?? null : opts.apiKey;
    if (opts.caller) { this.caller = opts.caller; this.disabledReason = null; }
    else if (apiKey) { this.caller = anthropicCaller(apiKey, this.model); this.disabledReason = null; }
    else { this.caller = null; this.disabledReason = "clé ANTHROPIC_API_KEY absente : la lecture par modèle de langage est désactivée, le lecteur à règles reste actif"; }
  }

  attach(radar: RadarService | null): void {
    this.radar = radar;
    // nouveaux corps de documents conservés par la lecture des fondamentaux : passage en tâche de fond
    this.fundamentals.on("bodies", () => void this.runInBackground());
  }

  /** Passage au démarrage (deux minutes) puis toutes les six heures ; LLM_AUTO=0 désactive. */
  start(): void {
    if (!this.caller || process.env.LLM_AUTO === "0") return;
    setTimeout(() => void this.runInBackground(), 120_000);
    setInterval(() => void this.runInBackground(), 6 * 3_600_000);
  }

  get enabled(): boolean {
    return this.caller != null;
  }

  private async runInBackground(): Promise<void> {
    if (!this.caller || this.running) return;
    try {
      await this.run();
    } catch (e) {
      console.warn(`[llm] lecture automatique : ${(e as Error).message}`);
    }
  }

  private usedToday(): number {
    const start = Math.floor(Date.now() / DAY) * DAY;
    return (this.db.prepare("SELECT COUNT(*) AS n FROM llm_extractions WHERE ts >= ?").get(start) as { n: number }).n;
  }

  /** Corps de documents jamais soumis au modèle (ou soumis avec une erreur technique), les plus récents d'abord. */
  private pendingBodies(limit: number): { url: string; symbol: string; title: string; source: string; published_at: number | null; text: string }[] {
    return this.db
      .prepare(
        `SELECT b.url, b.symbol, b.title, b.source, b.published_at, b.text FROM document_bodies b
         WHERE NOT EXISTS (SELECT 1 FROM llm_extractions x WHERE x.url = b.url AND x.status IN ('ok','vide','refus'))
         ORDER BY b.published_at DESC, b.fetched_at DESC LIMIT ?`,
      )
      .all(limit) as { url: string; symbol: string; title: string; source: string; published_at: number | null; text: string }[];
  }

  private pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM document_bodies b WHERE NOT EXISTS (SELECT 1 FROM llm_extractions x WHERE x.url = b.url AND x.status IN ('ok','vide','refus'))").get() as { n: number }).n;
  }

  private userMessage(text: string, hint: { symbol?: string | null; title?: string | null; source?: string | null; publishedAt?: number | null }): string {
    const list = INSTRUMENTS.map((i) => `${i.symbol} = ${i.name}`).join(" ; ");
    const head = [
      hint.symbol ? `Société attendue : ${hint.symbol} (${INSTRUMENT_MAP.get(hint.symbol)?.name ?? "?"}).` : null,
      hint.title ? `Titre du document : ${hint.title}.` : null,
      hint.source ? `Source : ${hint.source}.` : null,
      hint.publishedAt ? `Date de collecte : ${new Date(hint.publishedAt).toISOString().slice(0, 10)}.` : null,
    ].filter(Boolean).join(" ");
    return `Symboles de la cote : ${list}.\n${head}\n\nTexte de la publication :\n<<<\n${text.slice(0, MAX_CHARS)}\n>>>`;
  }

  /**
   * Soumet un texte au modèle ; avec `save`, enregistre les périodes dans les fondamentaux et les
   * événements dans le radar. `symbol` force la société (texte collé) ; sinon celle reconnue par le modèle.
   */
  async extract(text: string, opts: { symbol?: string | null; url?: string | null; title?: string | null; source?: string | null; publishedAt?: number | null; save?: boolean } = {}): Promise<LlmExtractionRow> {
    if (!this.caller) throw Object.assign(new Error(this.disabledReason ?? "lecture par modèle de langage désactivée"), { status: 503 });
    if (this.dailyMax > 0 && this.usedToday() >= this.dailyMax) throw Object.assign(new Error(`Budget quotidien atteint (${this.dailyMax} lecture(s) par jour, LLM_EXTRACT_DAILY_MAX)`), { status: 429 });
    const forced = opts.symbol ? opts.symbol.toUpperCase() : null;
    if (forced && !INSTRUMENT_MAP.has(forced)) throw Object.assign(new Error("Valeur inconnue"), { status: 400 });
    const ts = Date.now();
    let reply: LlmReply;
    try {
      reply = await this.caller({ system: SYSTEM_PROMPT, user: this.userMessage(text, { symbol: forced, title: opts.title, source: opts.source, publishedAt: opts.publishedAt }) });
    } catch (e) {
      const msg = e instanceof Anthropic.RateLimitError ? "limite de débit de l'API atteinte, nouvel essai au prochain passage" : e instanceof Anthropic.APIError ? `API ${e.status ?? ""} : ${e.message}` : (e as Error).message;
      return this.log({ url: opts.url ?? null, symbol: forced, model: this.model, ts, status: "erreur", result: null, inputTokens: 0, outputTokens: 0, periodsSaved: 0, eventsSaved: 0, error: msg.slice(0, 500) });
    }
    if (reply.stopReason === "refusal") return this.log({ url: opts.url ?? null, symbol: forced, model: reply.model, ts, status: "refus", result: null, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, periodsSaved: 0, eventsSaved: 0, error: "le modèle a refusé de traiter ce texte" });
    if (!reply.parsed) return this.log({ url: opts.url ?? null, symbol: forced, model: reply.model, ts, status: "erreur", result: null, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, periodsSaved: 0, eventsSaved: 0, error: reply.stopReason === "max_tokens" ? "réponse tronquée (max_tokens)" : "réponse non structurée" });
    const result = reply.parsed;
    const symbol = forced ?? (result.symbol && INSTRUMENT_MAP.has(result.symbol.toUpperCase()) ? result.symbol.toUpperCase() : null);
    const status: LlmExtractionRow["status"] = result.periods.length || result.events.length ? "ok" : "vide";
    let periodsSaved = 0;
    let eventsSaved = 0;
    if (opts.save !== false && symbol) {
      const saved = this.apply(symbol, result, opts.url ?? null, opts.source ?? null, reply.model);
      periodsSaved = saved.periods;
      eventsSaved = saved.events;
    }
    const row = this.log({ url: opts.url ?? null, symbol, model: reply.model, ts, status, result, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, periodsSaved, eventsSaved, error: symbol ? null : "société non reconnue : rien n'a été enregistré" });
    if (periodsSaved || eventsSaved) this.emit("extracted", row);
    return row;
  }

  /** Périodes vers les fondamentaux (statut auto, jamais par-dessus un analyste), événements vers le radar. */
  private apply(symbol: string, result: Extraction, url: string | null, source: string | null, model: string): { periods: number; events: number } {
    let periods = 0;
    let events = 0;
    const src = `auto · modèle de langage (${model})${source ? ` · ${source}` : ""}`;
    const publishedAt = isoDay(result.publishedAt);
    for (const p of result.periods) {
      if ([p.revenue, p.netIncome, p.equity, p.eps, p.dps, p.revenueGrowthPct, p.netIncomeGrowthPct].every((v) => v == null)) continue;
      try {
        this.fundamentals.upsert({ symbol, period: p.period, periodEnd: isoDay(p.periodEnd), publishedAt, revenue: p.revenue, netIncome: p.netIncome, equity: p.equity, shares: p.shares, eps: p.eps, dps: p.dps, revenueGrowthPct: p.revenueGrowthPct, netIncomeGrowthPct: p.netIncomeGrowthPct, source: src, url, note: result.confidence !== "haute" ? `confiance ${result.confidence}${result.warnings.length ? ` : ${result.warnings.join(" ; ").slice(0, 300)}` : ""}` : null }, null);
        periods++;
      } catch {
        // période invalide ou aucune donnée : ignorée, le reste est conservé
      }
    }
    if (this.radar) {
      for (const e of result.events) {
        const kind = RADAR_KIND[e.kind];
        if (!kind) continue;
        const name = INSTRUMENT_MAP.get(symbol)?.name ?? symbol;
        const title = `${name} : ${e.title}`.slice(0, 200);
        if (this.radar.record({ kind, symbol, title, detail: e.detail ? (e.kind === "avertissement" ? `Avertissement · ${e.detail}` : e.kind === "direction" ? `Direction · ${e.detail}` : e.detail).slice(0, 400) : null, url, source: "modèle de langage", date: isoDay(e.date) ?? publishedAt ?? Date.now() })) events++;
      }
    }
    return { periods, events };
  }

  private log(x: Omit<LlmExtractionRow, "id">): LlmExtractionRow {
    const info = this.db
      .prepare("INSERT INTO llm_extractions(url, symbol, model, ts, status, result, input_tokens, output_tokens, periods_saved, events_saved, error) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(x.url, x.symbol, x.model, x.ts, x.status, x.result ? JSON.stringify(x.result) : null, x.inputTokens, x.outputTokens, x.periodsSaved, x.eventsSaved, x.error);
    return { id: Number(info.lastInsertRowid), ...x };
  }

  /** Passage sur les corps en attente, dans la limite du budget quotidien et de `limit`. */
  async run(limit = 10): Promise<{ processed: number; saved: number; failed: number; skipped: string | null }> {
    if (!this.caller) return { processed: 0, saved: 0, failed: 0, skipped: this.disabledReason };
    if (this.running) return { processed: 0, saved: 0, failed: 0, skipped: "un passage est déjà en cours" };
    this.running = true;
    try {
      const budget = this.dailyMax > 0 ? Math.max(0, this.dailyMax - this.usedToday()) : limit;
      const n = Math.min(limit, budget);
      let processed = 0;
      let saved = 0;
      let failed = 0;
      if (n > 0) {
        for (const b of this.pendingBodies(n)) {
          const row = await this.extract(b.text, { symbol: b.symbol, url: b.url, title: b.title, source: b.source, publishedAt: b.published_at, save: true });
          processed++;
          if (row.status === "erreur") failed++;
          else if (row.periodsSaved || row.eventsSaved) saved++;
        }
      }
      this.lastRun = { at: Date.now(), processed, saved, failed };
      return { processed, saved, failed, skipped: n <= 0 && this.pendingCount() > 0 ? `budget quotidien atteint (${this.dailyMax})` : null };
    } finally {
      this.running = false;
    }
  }

  private row(r: Record<string, unknown>): LlmExtractionRow {
    return { id: Number(r.id), url: (r.url as string | null) ?? null, symbol: (r.symbol as string | null) ?? null, model: String(r.model), ts: Number(r.ts), status: r.status as LlmExtractionRow["status"], result: r.result ? (JSON.parse(String(r.result)) as Extraction) : null, inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), periodsSaved: Number(r.periods_saved), eventsSaved: Number(r.events_saved), error: (r.error as string | null) ?? null };
  }

  recent(limit = 20): LlmExtractionRow[] {
    return (this.db.prepare("SELECT * FROM llm_extractions ORDER BY ts DESC, id DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((r) => this.row(r));
  }

  status(): LlmStatus {
    const tot = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM llm_extractions").get() as { n: number; i: number; o: number };
    const bodies = (this.db.prepare("SELECT COUNT(*) AS n FROM document_bodies").get() as { n: number }).n;
    return { enabled: this.caller != null, reason: this.disabledReason, model: this.model, dailyMax: this.dailyMax, usedToday: this.usedToday(), bodies, pending: this.pendingCount(), extractions: tot.n, tokens: { input: tot.i, output: tot.o }, lastRun: this.lastRun, running: this.running, recent: this.recent(12) };
  }
}
