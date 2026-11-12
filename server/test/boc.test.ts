import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { detectSessionDate, layoutFromHeader, parseBocText } from "../src/data/boc.js";
import { BocService, expandSourceUrl, htmlToBocText, pdfToText } from "../src/services/boc.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { INSTRUMENTS } from "../src/data/instruments.js";
import { forecast } from "../src/engine/forecast.js";

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

const WHITESPACE_BOC = `BOURSE REGIONALE DES VALEURS MOBILIERES
BULLETIN OFFICIEL DE LA COTE - Séance du 10/11/2026
Symbole Titre Cours veille Ouverture Clôture Variation Volume Valeur Meilleure demande Qté Meilleure offre Qté Nb transactions
SNTS Sonatel 22450 22500 22600 +0,67 1 250 28 125 000 22550 400 22650 300 7
BOAB Bank of Africa Bénin 5200 5200 5590 RH +7,50 3 000 16 770 000 5590 2 500 - - 12
SICC SICOR 3500 - - - 0 0 - - - - 0 SUSP
TOTAL 4 250 44 895 000`;

const SEPARATED_BOC = `Symbole;Titre;Volume;Cours veille;Ouverture;Clôture;Variation;Demande;Qté demande;Offre;Qté offre;Transactions
SNTS;Sonatel;1250;22 450;22 500;22 600;0,67;22 550;400;22 650;300;7
SHEC;Vivo Energy CI;400;950;950;955 RB;-0,53;;;955;1 200;3`;

async function marketWithHistory(days = 120): Promise<{ market: MarketService; db: ReturnType<typeof openMemoryDb> }> {
  const db = openMemoryDb();
  ensureHistoryDepth(db, days);
  const market = new MarketService(db);
  const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void };
  await m.loadOrSeedHistory();
  for (const inst of INSTRUMENTS) m.initSnapshot(inst);
  return { market, db };
}

describe("lecture du bulletin officiel de la cote", () => {
  it("texte à blancs avec en-tête : colonnes reconnues, milliers fusionnés, réservations et suspensions", () => {
    const r = parseBocText(WHITESPACE_BOC);
    expect(r.sessionTs).toBe(utc(2026, 11, 10));
    expect(r.layoutSource).toBe("header");
    expect(r.layout).toEqual(["ref", "open", "close", "changePct", "volume", "value", "bid", "bidQty", "ask", "askQty", "trades"]);
    expect(r.rows).toHaveLength(3);
    const snts = r.rows[0];
    expect(snts).toMatchObject({ symbol: "SNTS", ref: 22450, open: 22500, close: 22600, changePct: 0.67, volume: 1250, value: 28125000, bid: 22550, bidQty: 400, ask: 22650, askQty: 300, trades: 7, reserved: null, suspended: false });
    const boab = r.rows[1];
    expect(boab).toMatchObject({ symbol: "BOAB", close: 5590, reserved: "up", volume: 3000, bidQty: 2500, ask: null, askQty: null, trades: 12 });
    expect(r.rows[2]).toMatchObject({ symbol: "SICC", suspended: true, volume: 0, close: 3500 });
    expect(r.unrecognized).toBe(0);
  });

  it("tableau à séparateurs : disposition par cellule, cellules vides, marqueur dans une cellule", () => {
    const r = parseBocText(SEPARATED_BOC);
    expect(r.layoutSource).toBe("header");
    expect(r.rows[0]).toMatchObject({ symbol: "SNTS", volume: 1250, ref: 22450, close: 22600, bid: 22550, bidQty: 400, ask: 22650, askQty: 300, trades: 7 });
    expect(r.rows[1]).toMatchObject({ symbol: "SHEC", close: 955, reserved: "down", bid: null, bidQty: null, ask: 955, askQty: 1200, trades: 3, changePct: -0.53 });
    expect(r.sessionTs).toBeNull();
  });

  it("sans en-tête : disposition de la page des cours BRVM (volume, veille, ouverture, clôture, variation) ou configurée", () => {
    const r = parseBocText("SNTS Sonatel 1 250 22450 22500 22600 +0,67");
    expect(r.layoutSource).toBe("default");
    expect(r.rows[0]).toMatchObject({ volume: 1250, ref: 22450, open: 22500, close: 22600, changePct: 0.67 });
    const c = parseBocText("SNTS Sonatel 22600 7", ["close", "trades"]);
    expect(c.layoutSource).toBe("config");
    expect(c.rows[0]).toMatchObject({ close: 22600, trades: 7, changePct: null });
  });

  it("en-têtes et dates : variantes de libellés", () => {
    expect(layoutFromHeader("Code Valeur Nbre titres Valeur transigée Cours de référence Cours de clôture Var %")).toEqual(["volume", "value", "ref", "close", "changePct"]);
    expect(layoutFromHeader("Symbole Titre")).toBeNull();
    expect(detectSessionDate("Cote du 3 novembre 2026")).toBe(utc(2026, 11, 3));
    expect(detectSessionDate("boc_2026-11-04.pdf")).toBe(utc(2026, 11, 4));
    expect(expandSourceUrl("https://h/boc_{YYYYMMDD}.pdf?d={DD-MM-YYYY}", utc(2026, 11, 4))).toBe("https://h/boc_20261104.pdf?d=04-11-2026");
    const text = htmlToBocText("<html><h1>Cote du 05/11/2026</h1><table><tr><th>Symbole</th><th>Titre</th><th>Volume</th><th>Clôture</th><th>Transactions</th></tr><tr><td>SNTS</td><td>Sonatel</td><td>1 250</td><td>22 600</td><td>7</td></tr></table></html>");
    const r = parseBocText(text);
    expect(r.sessionTs).toBe(utc(2026, 11, 5));
    expect(r.rows[0]).toMatchObject({ symbol: "SNTS", volume: 1250, close: 22600, trades: 7 });
  });

  it("extrait le texte d'un PDF (pdfjs) ligne par ligne", async () => {
    const lines = ["BOC Seance du 10/11/2026", "SNTS Sonatel 12000 22450 22500 22600 +0,67 7"];
    const content = `BT /F1 10 Tf 40 760 Td (${lines[0]}) Tj 0 -14 Td (${lines[1]}) Tj ET`;
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const text = await pdfToText(new TextEncoder().encode(pdf));
    expect(text.split("\n")[0]).toContain("Seance du 10/11/2026");
    const r = parseBocText(text, ["volume", "ref", "open", "close", "changePct", "trades"]);
    expect(r.sessionTs).toBe(utc(2026, 11, 10));
    expect(r.rows[0]).toMatchObject({ symbol: "SNTS", volume: 12000, close: 22600, trades: 7 });
  }, 20000);
});

describe("service du bulletin officiel", () => {
  it("import : statistiques par séance, bougie officielle, meilleures limites, séries pour la prévision", async () => {
    const { market, db } = await marketWithHistory(120);
    const boc = new BocService(db, market);
    const raw = market.history("SNTS", 5, false);
    const session = raw[raw.length - 3].ts; // séance déjà en base : la bougie est remplacée
    const r = boc.importText(WHITESPACE_BOC, session, "test");
    expect(r).toMatchObject({ session, rows: 3, applied: 3 });
    const after = market.history("SNTS", 5, false);
    const official = after.find((c) => c.ts === session)!;
    expect(official).toMatchObject({ open: 22500, close: 22600, volume: 1250 });
    expect(official.high).toBeGreaterThanOrEqual(22600);
    expect(boc.latest("SNTS")).toMatchObject({ trades: 7, bid: 22550, ask: 22650 });
    expect(boc.latest("SNTS")!.imbalance).toBeCloseTo((22550 * 400 - 22650 * 300) / (22550 * 400 + 22650 * 300), 2);
    expect(boc.latest("BOAB")).toMatchObject({ reserved: "up", imbalance: 1 });
    expect(boc.latest("SICC")?.suspended).toBe(true);
    expect(market.orderBook("SNTS")?.official).toMatchObject({ bid: 22550, bidQty: 400, ask: 22650, askQty: 300, ts: session });
    const dates = market.history("SNTS", 120).map((c) => c.ts);
    const s = boc.series("SNTS", dates)!;
    expect(s.imbalance.filter((v) => v != null)).toHaveLength(1);
    expect(s.reserved[dates.indexOf(session)]).toBe(0);
    expect(boc.series("BOAB", dates)!.reserved[dates.indexOf(session)]).toBe(1);
    expect(boc.series("ORAC", dates)).toBeNull();
    expect(boc.activity("BOAB")).toMatchObject({ sessions: 1, avgTrades: 12, reservedUp: 1 });
    expect(boc.status()).toMatchObject({ sessions: 1, lastSession: session, symbolsLastSession: 3 });
    expect(boc.session().items.map((i) => i.symbol)).toEqual(["BOAB", "SICC", "SNTS"]);
    // date de séance obligatoire quand le texte n'en porte pas
    expect(() => boc.importText(SEPARATED_BOC)).toThrow(/Date de séance/);
  });

  it("les facteurs du bulletin entrent dans la régression (nuls sans bulletin, présents avec)", async () => {
    const { market } = await marketWithHistory(400);
    const candles = market.history("SNTS", 400);
    const none = forecast({ symbol: "SNTS", candles, seed: 1 });
    const keys = none.horizons[1].contributions.map((c) => c.factor);
    expect(keys).toContain("imb1");
    expect(keys).toContain("res5");
    const imbalance = candles.map((_, i) => (i % 7 === 0 ? 0.6 : null));
    const reserved = candles.map((_, i) => (i % 11 === 0 ? 1 : 0));
    const withOfficial = forecast({ symbol: "SNTS", candles, seed: 1, official: { imbalance, reserved } });
    const c = withOfficial.horizons[1].contributions.find((x) => x.factor === "imb1")!;
    expect(Number.isFinite(c.contributionPct)).toBe(true);
    // séries mal alignées : ignorées sans erreur
    expect(() => forecast({ symbol: "SNTS", candles, seed: 1, official: { imbalance: [1], reserved: [0] } })).not.toThrow();
  });

  it("séances candidates : dernière séance close, jours ouvrés seulement", async () => {
    const { market, db } = await marketWithHistory(10);
    const boc = new BocService(db, market);
    expect(boc.candidateSessions(Date.UTC(2026, 10, 12, 10), 3)).toEqual([utc(2026, 11, 11), utc(2026, 11, 10), utc(2026, 11, 9)]);
    expect(boc.candidateSessions(Date.UTC(2026, 10, 16, 18), 2)).toEqual([utc(2026, 11, 16), utc(2026, 11, 13)]);
    const r = await boc.refresh();
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/BOC_SOURCES/);
  });
});
