import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { NewsService, matchSymbols, parseHtmlList, parseRss, scoreSentiment } from "../src/services/news.js";
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

const HTML = `<html><body><nav><a href="/">Accueil</a><a href="/marches">Marchés</a></nav>
<ul class="list">
<li><a href="/actualites/sonatel-dividende-2026">Sonatel annonce un dividende record pour l'exercice 2026</a><time datetime="2026-10-01T08:00:00Z">1 oct.</time><p>Le conseil propose 1 700 FCFA par action.</p></li>
<li><a href="https://www.richbourse.com/actualites/brvm-composite-recul">La BRVM Composite recule de 1,2 % dans un marché prudent</a></li>
<li><a href="https://autre-site.com/x/y/z">Un lien externe qui ne doit pas être retenu ici</a></li>
<li><a href="/img/photo.jpg">Une image avec un titre assez long pour passer</a></li>
</ul></body></html>`;

describe("collecte élargie", () => {
  it("extrait les articles d'une page de liste générique", () => {
    const items = parseHtmlList(HTML, "https://www.richbourse.com/common/actualites");
    expect(items.map((i) => i.url)).toEqual(["https://www.richbourse.com/actualites/sonatel-dividende-2026", "https://www.richbourse.com/actualites/brvm-composite-recul"]);
    expect(items[0].summary).toContain("1 700 FCFA");
    expect(new Date(items[0].publishedAt).toISOString()).toBe("2026-10-01T08:00:00.000Z");
  });
  it("pondère le sentiment par la crédibilité de la source et expose l'état par source", () => {
    const db = openMemoryDb();
    const news = new NewsService(db, []);
    const now = Date.now() - 3600_000;
    news.ingest("officiel", [{ title: "Sonatel : résultat net en hausse de 12 %", url: "https://a/1", summary: null, publishedAt: now }], 1);
    const strong = news.sentimentFor("SNTS").score;
    const db2 = openMemoryDb();
    const news2 = new NewsService(db2, []);
    news2.ingest("blog", [{ title: "Sonatel : résultat net en hausse de 12 %", url: "https://a/1", summary: null, publishedAt: now }], 0.5);
    news2.ingest("officiel", [{ title: "Sonatel : perte et amende, suspension de cotation", url: "https://a/2", summary: null, publishedAt: now }], 1);
    expect(strong).toBeGreaterThan(0);
    expect(news2.sentimentFor("SNTS").score).toBeLessThan(0); // la source crédible l'emporte
    expect(news.status().details).toEqual([]);
  });
  it("dispatch par type de source (statut ok / échec)", async () => {
    const db = openMemoryDb();
    const fetchImpl = (async (url: string) => (String(url).includes("ko") ? new Response("", { status: 503 }) : new Response(HTML, { status: 200 }))) as unknown as typeof fetch;
    const news = new NewsService(db, [
      { name: "RB", url: "https://www.richbourse.com/common/actualites", kind: "html-list", weight: 0.9, category: "bourse" },
      { name: "KO", url: "https://ko.example/feed", kind: "rss", weight: 0.5, category: "généraliste" },
    ], fetchImpl);
    const n = await news.refresh();
    expect(n).toBe(2);
    const st = news.status();
    expect(st.details.find((d) => d.name === "RB")?.ok).toBe(true);
    expect(st.details.find((d) => d.name === "KO")?.ok).toBe(false);
    expect(st.details.find((d) => d.name === "KO")?.error).toMatch(/503/);
  });
});
