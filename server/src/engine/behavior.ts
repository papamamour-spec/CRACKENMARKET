/**
 * Analyse comportementale de l'investisseur.
 * Combine le profil déclaré (questionnaire) et le comportement observé (ordres, consultations)
 * pour produire un profil effectif et détecter les biais classiques de la finance comportementale.
 */

export interface DeclaredProfile {
  riskTolerance: number; // 1..5
  horizonMonths: number;
  objective: "income" | "growth" | "balanced" | "speculative";
  experience: "beginner" | "intermediate" | "expert";
  monthlyCapacity: number;
  preferredSectors: string[];
}

export interface TradeRecord {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  realizedPnl: number;
  ts: number;
}

export interface BehaviorEvent {
  kind: string;
  symbol: string | null;
  ts: number;
}

export interface PositionRecord {
  symbol: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  sector: string;
}

export interface BehaviorBias {
  code: "overtrading" | "disposition" | "concentration" | "chasing" | "panic" | "inactivity" | "loss_streak";
  severity: number; // 0..1
  title: string;
  description: string;
  advice: string;
}

export interface BehaviorProfile {
  /** Tolérance au risque effective 1..5, ajustée par le comportement observé */
  effectiveRiskTolerance: number;
  declared: DeclaredProfile;
  tradesPerMonth: number;
  winRate: number;
  avgHoldingDays: number;
  totalRealizedPnl: number;
  biases: BehaviorBias[];
  /** Discipline 0..100 : capacité à suivre un plan (peu de biais, suivi des conseils) */
  disciplineScore: number;
  /** Poids conseillés dans le score de recommandation */
  weights: { trend: number; momentum: number; meanReversion: number; volume: number; risk: number; dividend: number };
  style: "Prudent" | "Équilibré" | "Dynamique" | "Spéculatif";
}

const DAY = 86_400_000;

export function buildBehaviorProfile(
  declared: DeclaredProfile,
  trades: TradeRecord[],
  events: BehaviorEvent[],
  positions: PositionRecord[],
  now = Date.now(),
): BehaviorProfile {
  const biases: BehaviorBias[] = [];
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  const firstTs = sorted[0]?.ts ?? now;
  const months = Math.max(1, (now - firstTs) / (30 * DAY));
  const tradesPerMonth = sorted.length / months;

  // Taux de réussite sur les ventes
  const sells = sorted.filter((t) => t.side === "sell");
  const wins = sells.filter((t) => t.realizedPnl > 0).length;
  const winRate = sells.length ? wins / sells.length : 0;
  const totalRealizedPnl = sells.reduce((a, t) => a + t.realizedPnl, 0);

  // Durée de détention moyenne (approx. FIFO par symbole)
  const holding: number[] = [];
  const openBuys = new Map<string, number[]>();
  for (const t of sorted) {
    if (t.side === "buy") {
      const arr = openBuys.get(t.symbol) ?? [];
      for (let i = 0; i < t.quantity; i++) arr.push(t.ts);
      openBuys.set(t.symbol, arr);
    } else {
      const arr = openBuys.get(t.symbol) ?? [];
      for (let i = 0; i < t.quantity && arr.length; i++) holding.push((t.ts - arr.shift()!) / DAY);
    }
  }
  const avgHoldingDays = holding.length ? holding.reduce((a, b) => a + b, 0) / holding.length : 0;

  // 1. Sur-activité (overtrading)
  const expectedPerMonth = declared.horizonMonths >= 24 ? 4 : declared.horizonMonths >= 12 ? 8 : 15;
  if (tradesPerMonth > expectedPerMonth * 1.5 && sorted.length >= 6) {
    biases.push({
      code: "overtrading",
      severity: Math.min(1, tradesPerMonth / (expectedPerMonth * 3)),
      title: "Sur-activité",
      description: `Vous passez environ ${tradesPerMonth.toFixed(1)} ordres par mois pour un horizon déclaré de ${declared.horizonMonths} mois.`,
      advice: "Sur la BRVM, les frais de courtage (≈1 à 1,5 % par ordre) et la faible liquidité pénalisent fortement les allers-retours fréquents. Privilégiez des positions de conviction.",
    });
  }

  // 2. Effet de disposition : on vend vite les gagnants, on garde les perdants
  const winnersHold = holdingsByOutcome(sorted, true);
  const losersHold = holdingsByOutcome(sorted, false);
  if (winnersHold.n >= 3 && losersHold.n >= 3 && winnersHold.avg < losersHold.avg * 0.6) {
    biases.push({
      code: "disposition",
      severity: Math.min(1, 1 - winnersHold.avg / losersHold.avg),
      title: "Effet de disposition",
      description: `Vos gains sont pris après ${winnersHold.avg.toFixed(0)} jours en moyenne, vos pertes conservées ${losersHold.avg.toFixed(0)} jours.`,
      advice: "Définissez un stop de protection et un objectif de cours à l'achat, et respectez-les : laissez courir les gains, coupez les pertes.",
    });
  }
  // Positions en forte perte latente conservées
  const heavyLosers = positions.filter((p) => p.currentPrice / p.avgPrice - 1 < -0.2);
  if (heavyLosers.length) {
    biases.push({
      code: "loss_streak",
      severity: Math.min(1, heavyLosers.length / Math.max(1, positions.length)),
      title: "Pertes latentes importantes",
      description: `${heavyLosers.length} position(s) en perte de plus de 20 % : ${heavyLosers.map((p) => p.symbol).join(", ")}.`,
      advice: "Réévaluez chaque ligne sur ses fondamentaux et sa tendance, pas sur votre prix d'achat : le marché ignore votre prix de revient.",
    });
  }

  // 3. Concentration
  const totalValue = positions.reduce((a, p) => a + p.quantity * p.currentPrice, 0);
  if (totalValue > 0) {
    const bySector = new Map<string, number>();
    let maxLine = 0;
    for (const p of positions) {
      const v = p.quantity * p.currentPrice;
      maxLine = Math.max(maxLine, v / totalValue);
      bySector.set(p.sector, (bySector.get(p.sector) ?? 0) + v / totalValue);
    }
    const maxSector = Math.max(...bySector.values());
    if (maxLine > 0.4 || maxSector > 0.6) {
      const sectorName = [...bySector.entries()].sort((a, b) => b[1] - a[1])[0][0];
      biases.push({
        code: "concentration",
        severity: Math.min(1, Math.max(maxLine, maxSector * 0.8)),
        title: "Concentration excessive",
        description:
          maxLine > 0.4
            ? `Une seule ligne représente ${(maxLine * 100).toFixed(0)} % de votre portefeuille.`
            : `Le secteur ${sectorName} représente ${(maxSector * 100).toFixed(0)} % de votre portefeuille.`,
        advice: "Répartissez sur au moins 5 à 8 valeurs et 3 secteurs (banques, télécoms, agro-industrie, distribution…) pour lisser le risque spécifique.",
      });
    }
  }

  // 4. Achat après forte hausse (chasing) : détecté via les événements « order » annotés côté serveur
  const chasing = events.filter((e) => e.kind === "order_chasing").length;
  const buys = sorted.filter((t) => t.side === "buy").length;
  if (buys >= 4 && chasing / buys > 0.4) {
    biases.push({
      code: "chasing",
      severity: Math.min(1, chasing / buys),
      title: "Achats après forte hausse",
      description: `${Math.round((chasing / buys) * 100)} % de vos achats interviennent après une hausse de plus de 8 % en 5 séances.`,
      advice: "Attendez un repli vers la moyenne mobile 20 séances ou un support avant d'entrer : le meilleur moment d'acheter est rarement après l'euphorie.",
    });
  }

  // 5. Ventes paniques : vente après forte baisse en séance
  const panic = events.filter((e) => e.kind === "order_panic").length;
  if (sells.length >= 3 && panic / sells.length > 0.4) {
    biases.push({
      code: "panic",
      severity: Math.min(1, panic / sells.length),
      title: "Ventes sous stress",
      description: `${Math.round((panic / sells.length) * 100)} % de vos ventes surviennent après une chute de plus de 6 % en 5 séances.`,
      advice: "Fixez vos seuils de sortie à froid, à l'avance. Une alerte de cours vous évite de décider dans l'émotion.",
    });
  }

  // 6. Inactivité : profil « croissance » avec beaucoup de cash non investi et aucune opération
  const views = events.filter((e) => e.kind === "view").length;
  if (sorted.length === 0 && views > 30 && declared.objective !== "income") {
    biases.push({
      code: "inactivity",
      severity: 0.4,
      title: "Analyse sans passage à l'acte",
      description: `Vous avez consulté ${views} fiches valeurs sans passer d'ordre.`,
      advice: "Commencez petit : une première ligne sur une valeur de rendement liquide (Sonatel, BOA, Vivo Energy…) permet d'apprendre en limitant le risque.",
    });
  }

  // Tolérance effective : la déclaration est modulée par le comportement
  let effective = declared.riskTolerance;
  if (biases.some((b) => b.code === "panic")) effective -= 1;
  if (biases.some((b) => b.code === "chasing" || b.code === "overtrading")) effective -= 0.5;
  if (declared.experience === "beginner") effective -= 0.5;
  if (declared.experience === "expert") effective += 0.25;
  effective = Math.max(1, Math.min(5, effective));

  const biasPenalty = biases.reduce((a, b) => a + b.severity * 20, 0);
  const followed = events.filter((e) => e.kind === "advice_followed").length;
  const ignored = events.filter((e) => e.kind === "advice_ignored").length;
  const adherence = followed + ignored > 0 ? (followed / (followed + ignored)) * 20 : 10;
  const disciplineScore = Math.round(Math.max(0, Math.min(100, 80 - biasPenalty + adherence)));

  const style = effective < 2 ? "Prudent" : effective < 3.25 ? "Équilibré" : effective < 4.25 ? "Dynamique" : "Spéculatif";

  // Pondérations du moteur selon le style
  const weights =
    style === "Prudent"
      ? { trend: 0.3, momentum: 0.1, meanReversion: 0.1, volume: 0.05, risk: 0.25, dividend: 0.2 }
      : style === "Équilibré"
        ? { trend: 0.3, momentum: 0.2, meanReversion: 0.15, volume: 0.1, risk: 0.15, dividend: 0.1 }
        : style === "Dynamique"
          ? { trend: 0.3, momentum: 0.3, meanReversion: 0.15, volume: 0.15, risk: 0.05, dividend: 0.05 }
          : { trend: 0.2, momentum: 0.4, meanReversion: 0.2, volume: 0.2, risk: 0, dividend: 0 };
  if (declared.objective === "income") {
    weights.dividend += 0.15;
    weights.momentum = Math.max(0, weights.momentum - 0.15);
  }

  return {
    effectiveRiskTolerance: effective,
    declared,
    tradesPerMonth,
    winRate,
    avgHoldingDays,
    totalRealizedPnl,
    biases,
    disciplineScore,
    weights,
    style,
  };
}

function holdingsByOutcome(trades: TradeRecord[], winners: boolean): { n: number; avg: number } {
  const openBuys = new Map<string, number[]>();
  const hold: number[] = [];
  for (const t of trades) {
    if (t.side === "buy") {
      const arr = openBuys.get(t.symbol) ?? [];
      for (let i = 0; i < t.quantity; i++) arr.push(t.ts);
      openBuys.set(t.symbol, arr);
    } else if ((t.realizedPnl > 0) === winners) {
      const arr = openBuys.get(t.symbol) ?? [];
      if (arr.length) hold.push((t.ts - arr[0]) / DAY);
      arr.splice(0, t.quantity);
    } else {
      const arr = openBuys.get(t.symbol) ?? [];
      arr.splice(0, t.quantity);
    }
  }
  return { n: hold.length, avg: hold.length ? hold.reduce((a, b) => a + b, 0) / hold.length : 0 };
}
