import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../src/db/index.js";
import { NewsService } from "../src/services/news.js";
import { DocumentService, classifyDocument, extractPeriod, parseDateText, parseDocumentLinks } from "../src/services/documents.js";

const PAGE = `<html><body>
<table>
<tr><td>12/03/2026</td><td><a href="/documents/sonatel-rapport-annuel-2025.pdf">Sonatel – Rapport annuel 2025</a></td></tr>
<tr><td>28/02/2026</td><td><a href="https://files.example.com/snts/etats-financiers-31-12-2025.pdf">Sonatel : États financiers au 31 décembre 2025</a></td></tr>
<tr><td>15 août 2025</td><td><a href="/documents/sgbci-s1-2025.pdf">SGBCI – Résultats du 1er semestre 2025 : résultat net en hausse de 10 %</a></td></tr>
<tr><td>2025-05-02</td><td><a href="/documents/avis-dividende-orange-ci-2024.pdf">Orange Côte d'Ivoire – Avis de mise en paiement du dividende 2024</a></td></tr>
<tr><td>—</td><td><a href="/apprendre/article/lexique">Lexique boursier et vocabulaire</a></td></tr>
<tr><td>—</td><td><a href="/documents/note-generale.pdf">Note sur le marché sans société identifiable</a></td></tr>
</table>
<ul><li><span class="title">Convocation à l'assemblée générale ordinaire 2026</span> <time datetime="2026-04-10">10 avr.</time> <a href="/documents/ago-2026.pdf">Télécharger</a></li></ul>
</body></html>`;

describe("documents des sociétés", () => {
  it("classe les documents et extrait la période", () => {
    expect(classifyDocument("Sonatel – Rapport annuel 2025")).toBe("rapport_annuel");
    expect(classifyDocument("États financiers au 31 décembre 2025")).toBe("etats_financiers");
    expect(classifyDocument("Résultats du 1er semestre 2025")).toBe("resultats");
    expect(classifyDocument("Avis de mise en paiement du dividende 2024")).toBe("dividende");
    expect(classifyDocument("Convocation à l'assemblée générale ordinaire")).toBe("assemblee");
    expect(classifyDocument("Note d'information – emprunt obligataire")).toBe("note_information");
    expect(extractPeriod("Résultats du 1er semestre 2025")).toBe("S1 2025");
    expect(extractPeriod("Activité au 3e trimestre 2025")).toBe("T3 2025");
    expect(extractPeriod("Rapport annuel 2025")).toBe("2025");
    expect(parseDateText("publié le 12/03/2026")).toBe(Date.UTC(2026, 2, 12));
    expect(parseDateText("15 août 2025")).toBe(Date.UTC(2025, 7, 15));
    expect(parseDateText("2026-04-10")).toBe(Date.UTC(2026, 3, 10));
  });
  it("extrait les documents d'une page et les rattache aux sociétés", () => {
    const docs = parseDocumentLinks(PAGE, "https://www.richbourse.com/investisseur/rapport-activite");
    expect(docs.map((d) => d.symbol)).toEqual(["SNTS", "SNTS", "SGBC", "ORAC", undefined, undefined]);
    expect(docs[0].url).toBe("https://www.richbourse.com/documents/sonatel-rapport-annuel-2025.pdf");
    expect(docs[0].publishedAt).toBe(Date.UTC(2026, 2, 12));
    expect(docs[1].url).toBe("https://files.example.com/snts/etats-financiers-31-12-2025.pdf");
    expect(docs[2].publishedAt).toBe(Date.UTC(2025, 7, 15));
    // lien « Télécharger » : titre pris dans le bloc, date dans <time>
    const ago = docs.find((d) => d.url.endsWith("ago-2026.pdf"))!;
    expect(ago.title).toMatch(/assemblée générale/i);
    expect(ago.publishedAt).toBe(Date.UTC(2026, 3, 10));
    // page société : symbole imposé
    const forced = parseDocumentLinks(PAGE, "https://www.richbourse.com/common/societe/details/SNTS", "SNTS");
    expect(forced.every((d) => d.symbol === "SNTS")).toBe(true);
  });
  it("stocke l'historique, le groupe par année et alimente la veille", () => {
    const db = openMemoryDb();
    const news = new NewsService(db, []);
    const svc = new DocumentService(db, []);
    svc.attachNews(news);
    const n = svc.ingest("test", parseDocumentLinks(PAGE, "https://www.richbourse.com/investisseur/rapport-activite"));
    expect(n).toBe(4); // les deux liens sans société sont ignorés ; l'AGO sans société aussi
    expect(svc.ingest("test", parseDocumentLinks(PAGE, "https://www.richbourse.com/investisseur/rapport-activite"))).toBe(0); // idempotent
    const h = svc.history("SNTS");
    expect(h.total).toBe(2);
    expect(h.years[0].year).toBe("2025");
    expect(h.latestAnnualReport!.title).toMatch(/Rapport annuel/);
    expect(h.kinds.rapport_annuel).toBe(1);
    expect(svc.list({ kind: "dividende" })).toHaveLength(1);
    expect(svc.list({ q: "semestre" })).toHaveLength(1);
    // les résultats et dividendes sont aussi des actualités (sentiment)
    const sg = news.latest(10, "SGBC");
    expect(sg).toHaveLength(1);
    expect(sg[0].sentiment).toBeGreaterThan(0); // « résultat net en hausse »
    expect(svc.status().documents).toBe(4);
    expect(svc.status().companies).toBe(3);
  });
  it("importe une liste collée et collecte via fetch factice (liste paginée et page société)", async () => {
    const db = openMemoryDb();
    const svc = new DocumentService(db, []);
    const imp = svc.importText("SNTS ; Rapport annuel 2024 ; https://ex.com/ra2024.pdf ; 2025-04-30\nXXXX ; Doc ; https://ex.com/x.pdf\nSNTS ; sans url ; pas-une-url");
    expect(imp.inserted).toBe(1);
    expect(imp.rejected).toHaveLength(2);
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("page=")) return new Response("<html></html>", { status: 200 });
      if (u.includes("/societe/")) return new Response(`<a href="/documents/etats-${u.split("/").pop()}-2025.pdf">États financiers 2025</a>`, { status: 200 });
      if (u.includes("ko")) return new Response("", { status: 500 });
      return new Response(PAGE, { status: 200 });
    }) as unknown as typeof fetch;
    const svc2 = new DocumentService(openMemoryDb(), [
      { name: "liste", url: "https://ex.com/rapports" },
      { name: "société", url: "https://ex.com/societe/{symbol}", perCompany: true },
      { name: "ko", url: "https://ko.example/x" },
    ], fetchImpl);
    const n = await svc2.refresh(["SNTS", "ORAC"]);
    expect(n).toBe(4 + 2);
    const st = svc2.status();
    expect(st.lastRun!.ok).toEqual(["liste", "société"]);
    expect(st.lastRun!.failed[0]).toMatch(/^ko/);
    expect(svc2.history("ORAC").total).toBe(2); // avis de dividende + états financiers de la page société
  });
});
