/**
 * Tests de résistance d'un portefeuille (actions, obligations, liquidités).
 *
 * - Scénarios historiques : la pire fenêtre de l'indice composite sur `windowDays` séances dans
 *   l'historique disponible (2020 dès que l'historique réel le couvre) et le meilleur rallye ; chaque
 *   valeur subit son propre rendement sur la fenêtre, ou bêta × indice si elle n'a pas d'historique.
 * - Chocs hypothétiques : krach de place (−20 % × bêta), choc sur le premier secteur du portefeuille,
 *   suspension du dividende de la première ligne.
 * - Scénarios de taux pour la poche obligataire : ±100 et +200 points de base par duration et convexité.
 */

export interface StressLine {
  symbol: string;
  weight: number;
  /** bêta de marché (régression sur l'indice) */
  beta: number;
  sector: string;
  /** rendement du dividende (décimal) pour le scénario de suspension */
  dividendYield: number;
  /** rendements quotidiens (log) alignés par la fin avec l'indice */
  returns: number[] | null;
}

export interface StressInput {
  lines: StressLine[];
  /** rendements quotidiens (log) de l'indice composite, alignés par la fin */
  index: { ts: number; r: number }[];
  /** poche obligataire : poids, duration modifiée moyenne, convexité moyenne */
  bonds: { weight: number; duration: number; convexity: number } | null;
  total: number;
  windowDays?: number;
}

export interface StressScenario {
  key: string;
  label: string;
  kind: "historique" | "choc" | "taux";
  equityPct: number;
  bondPct: number;
  totalPct: number;
  amount: number;
  window: { from: number; to: number; indexPct: number } | null;
  lines: { symbol: string; pct: number; contributionPct: number }[];
  note: string;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

function windowReturn(rs: number[], from: number, to: number): number {
  let s = 0;
  for (let t = from; t < to; t++) s += rs[t];
  return Math.exp(s) - 1;
}

export function stressTest(input: StressInput): StressScenario[] {
  const { lines, bonds, total } = input;
  const windowDays = input.windowDays ?? 63;
  const idx = input.index.map((x) => x.r);
  const scenarios: StressScenario[] = [];
  const equityWeight = lines.reduce((a, l) => a + l.weight, 0);
  const bondWeight = bonds?.weight ?? 0;

  const build = (key: string, label: string, kind: StressScenario["kind"], lineRet: (l: StressLine) => number, bondRet: number, note: string, window: StressScenario["window"] = null): StressScenario => {
    const per = lines.map((l) => {
      const pct = lineRet(l);
      return { symbol: l.symbol, pct: r1(pct * 100), contributionPct: r2(pct * l.weight * 100) };
    });
    const equity = per.reduce((a, p) => a + p.contributionPct, 0);
    const bondPct = r2(bondRet * bondWeight * 100);
    const totalPct = r2(equity + bondPct);
    return { key, label, kind, equityPct: r2(equity), bondPct, totalPct, amount: Math.round((totalPct / 100) * total), window, lines: per.sort((a, b) => a.contributionPct - b.contributionPct), note };
  };

  // ---- fenêtres historiques de l'indice ----
  if (idx.length >= windowDays + 5) {
    let worst = { from: 0, ret: Infinity };
    let best = { from: 0, ret: -Infinity };
    let acc = 0;
    for (let t = 0; t < idx.length; t++) {
      acc += idx[t];
      if (t >= windowDays) acc -= idx[t - windowDays];
      if (t >= windowDays - 1) {
        const r = Math.exp(acc) - 1;
        const from = t - windowDays + 1;
        if (r < worst.ret) worst = { from, ret: r };
        if (r > best.ret) best = { from, ret: r };
      }
    }
    for (const [key, w, label] of [["pire_fenetre", worst, "Pire fenêtre de l'indice"], ["meilleur_rallye", best, "Meilleur rallye de l'indice"]] as const) {
      const to = w.from + windowDays;
      const fromTs = input.index[w.from].ts;
      const toTs = input.index[to - 1].ts;
      scenarios.push(build(key, `${label} (${new Date(fromTs).toLocaleDateString("fr-FR")} → ${new Date(toTs).toLocaleDateString("fr-FR")}, ${w.ret > 0 ? "+" : ""}${r1(w.ret * 100)} %)`, "historique", (l) => {
        if (l.returns && l.returns.length >= idx.length) {
          const off = l.returns.length - idx.length;
          return windowReturn(l.returns, off + w.from, off + to);
        }
        return l.beta * w.ret;
      }, 0, key === "pire_fenetre" ? "Rejoue, valeur par valeur, la pire période de trois mois de l'indice dans l'historique disponible ; la poche obligataire est supposée stable." : "Rejoue la meilleure période de trois mois de l'indice : ce que le portefeuille aurait capté d'un rallye de place.", { from: fromTs, to: toTs, indexPct: r1(w.ret * 100) }));
    }
  }

  // ---- chocs hypothétiques ----
  scenarios.push(build("krach_20", "Krach de place −20 %", "choc", (l) => -0.2 * Math.max(0.2, l.beta), 0, "Baisse de 20 % de l'indice transmise à chaque valeur par son bêta (plancher 0,2) ; obligations inchangées."));
  const sectors = new Map<string, number>();
  for (const l of lines) sectors.set(l.sector, (sectors.get(l.sector) ?? 0) + l.weight);
  const topSector = [...sectors.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topSector) scenarios.push(build("choc_secteur", `Choc −15 % sur le secteur ${topSector[0]}`, "choc", (l) => (l.sector === topSector[0] ? -0.15 : 0), 0, `Le premier secteur du portefeuille (${r1(topSector[1] * 100)} % de la valeur) perd 15 %, les autres valeurs sont stables.`));
  const topLine = [...lines].sort((a, b) => b.weight - a.weight)[0];
  if (topLine && topLine.dividendYield > 0) scenarios.push(build("dividende_suspendu", `Suspension du dividende de ${topLine.symbol}`, "choc", (l) => (l.symbol === topLine.symbol ? -Math.min(0.3, topLine.dividendYield * 3) : 0), 0, "Une suspension de dividende coûte typiquement trois années de rendement au cours ; les autres lignes sont stables."));

  // ---- taux ----
  if (bonds && bonds.weight > 0) {
    const bondMove = (bp: number) => {
      const dy = bp / 10_000;
      return -bonds.duration * dy + 0.5 * bonds.convexity * dy * dy;
    };
    for (const bp of [100, 200, -100]) scenarios.push(build(`taux_${bp > 0 ? "+" : ""}${bp}`, `Taux ${bp > 0 ? "+" : ""}${bp} pb`, "taux", () => 0, bondMove(bp), `Variation parallèle des taux de ${bp > 0 ? "+" : ""}${bp} points de base : poche obligataire par duration (${r2(bonds.duration)}) et convexité ; actions supposées stables.`));
  }
  return scenarios.map((s) => ({ ...s, equityPct: r2(s.equityPct), lines: s.lines.slice(0, 12) }));
}

/** Bêtas de marché par régression simple des rendements sur l'indice (alignés par la fin). */
export function marketBetas(returns: Map<string, number[]>, index: number[]): Map<string, number> {
  const out = new Map<string, number>();
  const mi = index.length ? index.reduce((a, b) => a + b, 0) / index.length : 0;
  let vi = 0;
  for (const r of index) vi += (r - mi) ** 2;
  for (const [sym, rs] of returns) {
    const n = Math.min(rs.length, index.length);
    if (n < 30 || vi <= 0) { out.set(sym, 1); continue; }
    const a = rs.slice(-n);
    const b = index.slice(-n);
    const ma = a.reduce((x, y) => x + y, 0) / n;
    const mb = b.reduce((x, y) => x + y, 0) / n;
    let cv = 0;
    let vb = 0;
    for (let t = 0; t < n; t++) { cv += (a[t] - ma) * (b[t] - mb); vb += (b[t] - mb) ** 2; }
    out.set(sym, vb > 0 ? Math.round((cv / vb) * 100) / 100 : 1);
  }
  return out;
}
