import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { NewsService, matchSymbols, parseRss, scoreSentiment } from "../src/services/news.js";
import { generateDailyHistory } from "../src/data/providers/simulation.js";
import { INSTRUMENT_MAP } from "../src/data/instruments.js";
import { analyze } from "../src/engine/technical.js";
import { buildBehaviorProfile } from "../src/engine/behavior.js";
import { recommend } from "../src/engine/advisor.js";

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Sonatel : résultat net en hausse de 12 % au premier semestre</title><link>https://ex.com/a</link><description>Le groupe Sonatel annonce une progression de son bénéfice.</description><pubDate>Mon, 21 Sep 2026 10:00:00 GMT</pubDate></item>
<item><title>La BRVM suspend la cotation de SETAO après un défaut de publication</title><link>https://ex.com/b</link><pubDate>Tue, 22 Sep 2026 09:00:00 GMT</pubDate></item>
<item><title>Recette de mafé</title><link>https://ex.com/c</link></item>
</channel></rss>`;

describe("veille d'actualité", () => {
  it("analyse un flux RSS et rattache les articles aux valeurs", () => {
    const items = parseRss(RSS);
    expect(items).toHaveLength(3);
    expect(matchSymbols(items[0].title)).toEqual(["SNTS"]);
    expect(matchSymbols(items[1].title)).toContain("STAC");
  });
  it("score de sentiment lexical", () => {
    expect(scoreSentiment("résultat net en hausse, dividende record")).toBeGreaterThan(0.3);
    expect(scoreSentiment("suspension de cotation après une perte et une amende")).toBeLessThan(-0.3);
    expect(scoreSentiment("assemblée générale ordinaire")).toBe(0);
  });
  it("ingère, filtre le hors-sujet et agrège le sentiment par valeur", () => {
    const db = openMemoryDb();
    const news = new NewsService(db, []);
    const n = news.ingest("test", parseRss(RSS).map((i) => ({ ...i, publishedAt: Date.now() - 3600_000 })));
    expect(n).toBe(2); // la recette est ignorée
    expect(news.sentimentFor("SNTS").score).toBeGreaterThan(0);
    expect(news.sentimentFor("STAC").score).toBeLessThan(0);
    expect(news.marketSentiment().count).toBe(1); // article BRVM
    expect(news.latest(10, "SNTS")).toHaveLength(1);
  });
  it("une actualité défavorable tempère la recommandation", () => {
    const inst = INSTRUMENT_MAP.get("SNTS")!;
    const tech = analyze("SNTS", generateDailyHistory(inst, 300));
    const profile = buildBehaviorProfile({ riskTolerance: 3, horizonMonths: 24, objective: "growth", experience: "intermediate", monthlyCapacity: 0, preferredSectors: [] }, [], [], []);
    const base = recommend(tech, { profile, positions: [], cash: 1_000_000 });
    const bad = recommend(tech, { profile, positions: [], cash: 1_000_000, news: new Map([["SNTS", { score: -0.8, count: 2, headlines: [{ title: "Sonatel sanctionné", sentiment: -0.8, source: "t" }] }]]) });
    expect(bad.score).toBeLessThan(base.score);
    expect(bad.warnings.some((w) => w.includes("Actualité récente défavorable"))).toBe(true);
    expect(bad.confidence).toBeLessThanOrEqual(base.confidence);
  });
});
