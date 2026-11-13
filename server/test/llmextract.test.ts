import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { INSTRUMENTS } from "../src/data/instruments.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { FundamentalsService } from "../src/services/fundamentals.js";
import { RadarService } from "../src/services/radar.js";
import { ExtractionSchema, LlmExtractService, SYSTEM_PROMPT, type Extraction, type LlmCall, type LlmReply } from "../src/services/llmextract.js";

async function setup() {
  const db = openMemoryDb();
  ensureHistoryDepth(db, 60);
  const market = new MarketService(db);
  const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void };
  await m.loadOrSeedHistory();
  for (const inst of INSTRUMENTS) m.initSnapshot(inst);
  const fundamentals = new FundamentalsService(db, market);
  const radar = new RadarService(db, null, null, null);
  return { db, market, fundamentals, radar };
}

const body = (db: ReturnType<typeof openMemoryDb>, url: string, symbol: string, text = "x".repeat(1000), publishedAt = Date.UTC(2026, 2, 12)) =>
  db.prepare("INSERT INTO document_bodies(url, symbol, title, source, published_at, text, fetched_at) VALUES (?,?,?,?,?,?,?)").run(url, symbol, `Résultats ${symbol}`, "brvm.org", publishedAt, text, Date.now());

const sonatel: Extraction = {
  symbol: "SNTS",
  company: "Sonatel",
  documentKind: "resultats",
  publishedAt: "2026-03-12",
  periods: [
    { period: "2025", periodEnd: "2025-12-31", revenue: 1_650_200_000_000, netIncome: 312_000_000_000, equity: 1_100_000_000_000, shares: 100_000_000, eps: 3120, dps: 1750, revenueGrowthPct: 8.4, netIncomeGrowthPct: 5.1 },
    { period: "2024", periodEnd: "2024-12-31", revenue: 1_522_000_000_000, netIncome: 296_900_000_000, equity: null, shares: null, eps: null, dps: 1650, revenueGrowthPct: null, netIncomeGrowthPct: null },
  ],
  events: [
    { kind: "dividende", title: "Dividende brut de 1 750 FCFA proposé au titre de 2025", detail: "Soumis à l'assemblée générale du 28 avril 2026", date: "2026-04-28" },
    { kind: "direction", title: "Nomination d'un nouveau directeur financier", detail: null, date: null },
    { kind: "autre", title: "Changement de logo", detail: null, date: null },
  ],
  summary: "Sonatel progresse sur tous ses marchés.",
  confidence: "haute",
  warnings: [],
};

const reply = (parsed: Extraction | null, extra: Partial<LlmReply> = {}): LlmReply => ({ parsed, stopReason: parsed ? "end_turn" : "max_tokens", inputTokens: 1200, outputTokens: 300, model: "claude-test", ...extra });

describe("extraction par modèle de langage", () => {
  it("schéma de sortie : une lecture valide est acceptée, un champ manquant est refusé", () => {
    expect(ExtractionSchema.safeParse(sonatel).success).toBe(true);
    expect(ExtractionSchema.safeParse({ ...sonatel, periods: [{ period: "2025" }] }).success).toBe(false);
    expect(SYSTEM_PROMPT).toMatch(/FCFA/);
  });

  it("clé absente : service désactivé, statut explicite, passage sans appel", async () => {
    const { db, fundamentals } = await setup();
    const svc = new LlmExtractService(db, fundamentals, { apiKey: null });
    expect(svc.enabled).toBe(false);
    expect(svc.status().reason).toMatch(/ANTHROPIC_API_KEY/);
    body(db, "https://www.brvm.org/doc1.pdf", "SNTS");
    const r = await svc.run();
    expect(r).toMatchObject({ processed: 0, skipped: expect.stringMatching(/désactivée/) });
    await expect(svc.extract("texte", {})).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("passage sur les corps conservés : fondamentaux (auto) et radar alimentés, journal avec jetons, pas de relecture", async () => {
    const { db, fundamentals, radar } = await setup();
    const calls: LlmCall[] = [];
    const svc = new LlmExtractService(db, fundamentals, { caller: async (c) => { calls.push(c); return reply(sonatel); }, model: "claude-test" });
    svc.attach(radar);
    body(db, "https://www.brvm.org/doc1.pdf", "SNTS", "Sonatel publie ses résultats annuels 2025. " + "y".repeat(500));
    const r = await svc.run();
    expect(r).toMatchObject({ processed: 1, saved: 1, failed: 0, skipped: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toBe(SYSTEM_PROMPT);
    expect(calls[0].user).toMatch(/Société attendue : SNTS/);
    expect(calls[0].user).toMatch(/SNTS = Sonatel/);
    const recs = fundamentals.records("SNTS");
    expect(recs.map((x) => x.period)).toEqual(["2025", "2024"]);
    const y25 = recs.find((x) => x.period === "2025")!;
    expect(y25).toMatchObject({ status: "auto", revenue: 1_650_200_000_000, eps: 3120, dps: 1750, url: "https://www.brvm.org/doc1.pdf", publishedAt: Date.UTC(2026, 2, 12) });
    expect(y25.source).toMatch(/modèle de langage \(claude-test\)/);
    // radar : dividende et direction enregistrés, « autre » ignoré
    const events = radar.list({ limit: 10 });
    expect(events.map((e) => e.kind).sort()).toEqual(["assemblee", "dividende"]);
    expect(events.find((e) => e.kind === "dividende")!.title).toMatch(/Sonatel : Dividende brut/);
    // journal
    const st = svc.status();
    expect(st).toMatchObject({ enabled: true, model: "claude-test", bodies: 1, pending: 0, extractions: 1, usedToday: 1, tokens: { input: 1200, output: 300 } });
    expect(st.recent[0]).toMatchObject({ status: "ok", periodsSaved: 2, eventsSaved: 2, symbol: "SNTS" });
    // second passage : rien à relire
    expect(await svc.run()).toMatchObject({ processed: 0 });
    expect(calls).toHaveLength(1);
  });

  it("une lecture automatique ne remplace jamais la saisie d'un analyste", async () => {
    const { db, fundamentals } = await setup();
    fundamentals.upsert({ symbol: "SNTS", period: "2025", netIncome: 300_000_000_000, eps: 3000 }, 7);
    const svc = new LlmExtractService(db, fundamentals, { caller: async () => reply(sonatel) });
    const row = await svc.extract("texte collé " + "z".repeat(100), { symbol: "SNTS", save: true });
    expect(row.status).toBe("ok");
    const y25 = fundamentals.records("SNTS").find((x) => x.period === "2025")!;
    expect(y25.status).toBe("analyste");
    expect(y25.eps).toBe(3000);
    expect(y25.revenue).toBe(1_650_200_000_000); // champ vide complété
  });

  it("aperçu sans enregistrement, société non reconnue, refus, erreur d'API et budget quotidien", async () => {
    const { db, fundamentals } = await setup();
    let mode: "ok" | "unknown" | "refusal" | "throw" | "empty" = "ok";
    const svc = new LlmExtractService(db, fundamentals, {
      caller: async () => {
        if (mode === "throw") throw new Error("réseau indisponible");
        if (mode === "refusal") return reply(null, { stopReason: "refusal" });
        if (mode === "unknown") return reply({ ...sonatel, symbol: "ZZZZ" });
        if (mode === "empty") return reply(null);
        return reply(sonatel);
      },
      dailyMax: 4,
    });
    const preview = await svc.extract("texte " + "a".repeat(100), { symbol: "SNTS", save: false });
    expect(preview.status).toBe("ok");
    expect(preview.result?.periods).toHaveLength(2);
    expect(fundamentals.records("SNTS")).toHaveLength(0);
    mode = "unknown";
    const unknown = await svc.extract("texte " + "a".repeat(100), { save: true });
    expect(unknown).toMatchObject({ symbol: null, periodsSaved: 0, error: expect.stringMatching(/non reconnue/) });
    mode = "refusal";
    expect((await svc.extract("texte " + "a".repeat(100), { symbol: "SNTS", save: true })).status).toBe("refus");
    mode = "throw";
    const err = await svc.extract("texte " + "a".repeat(100), { symbol: "SNTS", save: true });
    expect(err).toMatchObject({ status: "erreur", error: "réseau indisponible" });
    // quatre lectures consommées : la cinquième dépasse le budget
    mode = "ok";
    await expect(svc.extract("texte " + "a".repeat(100), { symbol: "SNTS" })).rejects.toThrow(/Budget quotidien/);
    body(db, "https://www.brvm.org/doc2.pdf", "SGBC");
    expect(await svc.run()).toMatchObject({ processed: 0, skipped: expect.stringMatching(/budget quotidien/) });
    expect(svc.status().pending).toBe(1);
  });

  it("un corps en erreur technique est repris au passage suivant, un refus ne l'est pas", async () => {
    const { db, fundamentals } = await setup();
    let fail = true;
    const svc = new LlmExtractService(db, fundamentals, { caller: async () => { if (fail) throw new Error("boom"); return reply(sonatel); } });
    body(db, "https://www.brvm.org/doc3.pdf", "SNTS");
    expect(await svc.run()).toMatchObject({ processed: 1, failed: 1 });
    expect(svc.status().pending).toBe(1);
    fail = false;
    expect(await svc.run()).toMatchObject({ processed: 1, saved: 1 });
    expect(svc.status().pending).toBe(0);
  });
});

describe("corps des documents conservés par la lecture des fondamentaux", () => {
  it("le texte téléchargé est stocké une fois et l'événement « bodies » émis", async () => {
    const { db, market } = await setup();
    const { DocumentService } = await import("../src/services/documents.js");
    const { resetFetchPolicy } = await import("../src/services/fetchPolicy.js");
    resetFetchPolicy(0);
    const docs = new DocumentService(db, []);
    db.prepare("INSERT INTO company_documents(symbol, title, kind, period, url, published_at, source, summary, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)").run("SNTS", "Résultats annuels 2025", "resultats", "2025", "https://www.brvm.org/fr/doc/snts-2025.html", Date.UTC(2026, 2, 12), "brvm.org", null, Date.now());
    const page = `<html><body><h1>Sonatel : résultats annuels 2025</h1><p>${"Le chiffre d'affaires consolidé s'établit à 1 650,2 milliards de FCFA, en hausse de 8,4 %. ".repeat(6)}</p></body></html>`;
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const fundamentals = new FundamentalsService(db, market, fetchImpl);
    fundamentals.attach(docs, null, null);
    let emitted = 0;
    fundamentals.on("bodies", (n: number) => { emitted += n; });
    const r = await fundamentals.scan(true);
    expect(r.fetched).toBe(1);
    expect(emitted).toBe(1);
    const rows = db.prepare("SELECT url, symbol, length(text) AS n FROM document_bodies").all() as { url: string; symbol: string; n: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: "SNTS" });
    expect(rows[0].n).toBeGreaterThan(200);
    await fundamentals.scan(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM document_bodies").get() as { n: number }).n).toBe(1);
  });
});
