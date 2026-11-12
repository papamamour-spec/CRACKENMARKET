/**
 * Évaluation reproductible du moteur de prévision, en ligne de commande.
 *
 *   npm run evaluate -w server -- --sessions 400 --step 10 --topk 5 --fee 1.25 --out rapport.json
 *
 * Lit la base désignée par DB_PATH (sinon la base par défaut du serveur), complète l'historique
 * synthétique si la base est vide (HISTORY_DAYS), applique les ajustements d'opérations sur le
 * capital connus, puis exécute l'évaluation en marche avant (engine/evaluation.ts). Même base,
 * même configuration et même graine donnent le même rapport : le résultat peut être comparé
 * d'une version du modèle à l'autre.
 */
import fs from "node:fs";
import { getDb } from "../src/db/index.js";
import { config } from "../src/config.js";
import { INSTRUMENTS } from "../src/data/instruments.js";
import { MarketService, ensureHistoryDepth } from "../src/services/market.js";
import { CorporateService } from "../src/services/corporate.js";
import { EvaluationService } from "../src/services/evaluation.js";
import type { EvaluationReport } from "../src/engine/evaluation.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function markdown(r: EvaluationReport): string {
  const d = (ts: number | null) => (ts ? new Date(ts).toISOString().slice(0, 10) : "—");
  const pct = (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)} %`);
  const lines = [
    `# Évaluation en marche avant · ${new Date(r.generatedAt).toISOString().slice(0, 16).replace("T", " ")}`,
    "",
    `Univers : ${r.universe} valeurs · du ${d(r.firstDate)} au ${d(r.lastDate)} · ${r.config.sessions} séances, pas ${r.config.step}, top ${r.config.topK}, frais ${r.config.feePct} % par ordre, graine ${r.config.seed}.`,
    "",
    "| Horizon | Obs. | Direction | Référence | Erreur | Sans modèle | Gain | IC moyen | t | Intervalle 90 % | Brier | Top k | Équipondéré | Indice |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const h of r.horizons) {
    lines.push(`| ${h.horizon} | ${h.n} | ${Math.round(h.hitRate * 100)} % | ${Math.round(h.baselineHitRate * 100)} % | ${h.maePct} % | ${h.naiveMaePct} % | ${Math.round(h.skill * 100)} % | ${h.ic.mean ?? "—"} | ${h.ic.tStat ?? "—"} | ${Math.round(h.coverage90 * 100)} % | ${h.brier} | ${pct(h.strategy.topK.totalReturnPct)} | ${pct(h.strategy.equalWeight.totalReturnPct)} | ${pct(h.strategy.index?.totalReturnPct)} |`);
  }
  lines.push("", ...r.verdict.map((v) => `- ${v}`), "");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const db = getDb();
  const generated = ensureHistoryDepth(db, config.historyDays);
  if (generated) console.error(`[evaluate] base sans historique : ${generated} séances synthétiques générées (résultats non représentatifs du marché réel)`);
  const market = new MarketService(db);
  const m = market as unknown as { loadOrSeedHistory(): Promise<void>; initSnapshot(i: unknown): void };
  await m.loadOrSeedHistory();
  for (const inst of INSTRUMENTS) m.initSnapshot(inst);
  new CorporateService(db, market);
  const evaluation = new EvaluationService(db, market);
  const opts = { sessions: Number(arg("sessions") ?? 400), step: Number(arg("step") ?? 10), topK: Number(arg("topk") ?? 5), feePct: Number(arg("fee") ?? 1.25) };
  const t0 = Date.now();
  const report = evaluation.runSync(opts, (done, total) => process.stderr.write(`\r[evaluate] ${done}/${total} dates`));
  process.stderr.write(`\n[evaluate] terminé en ${Math.round((Date.now() - t0) / 1000)} s\n`);
  const out = arg("out");
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  process.stdout.write(markdown(report));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
