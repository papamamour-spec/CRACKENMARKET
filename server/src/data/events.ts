/**
 * Calendrier des événements des sociétés cotées (dividendes, assemblées, publications).
 * Calendrier INDICATIF construit à partir des habitudes de publication des émetteurs ;
 * les dates officielles sont fixées par les avis de la BRVM et des sociétés.
 * Les montants de dividende sont dérivés du rendement de référence et du cours de référence.
 */
import { INSTRUMENTS } from "./instruments.js";

export type EventKind = "dividend" | "agm" | "results" | "market";

export interface MarketEvent {
  id: string;
  symbol: string | null;
  kind: EventKind;
  title: string;
  date: number; // ms UTC
  detail: string;
  indicative: boolean;
}

function utc(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

export function buildEventCalendar(year = new Date().getUTCFullYear()): MarketEvent[] {
  const events: MarketEvent[] = [];
  let i = 0;
  for (const inst of INSTRUMENTS) {
    i++;
    // Publication des comptes annuels : février-avril ; AG : avril-juin ; dividende : mai-août
    const resultsDay = 20 + (i % 9);
    const resultsMonth = 2 + (i % 3);
    const agmMonth = 4 + (i % 3);
    const agmDay = 5 + (i % 20);
    const divMonth = agmMonth + 1 + (i % 2);
    const divDay = 8 + (i % 18);
    events.push({ id: `${inst.symbol}-results-${year}`, symbol: inst.symbol, kind: "results", title: `${inst.name} : comptes annuels ${year - 1}`, date: utc(year, resultsMonth, resultsDay), detail: "Publication des états financiers annuels audités.", indicative: true });
    events.push({ id: `${inst.symbol}-agm-${year}`, symbol: inst.symbol, kind: "agm", title: `${inst.name} : assemblée générale ordinaire`, date: utc(year, agmMonth, agmDay), detail: "Approbation des comptes et affectation du résultat.", indicative: true });
    if (inst.dividendYield > 0) {
      const dps = Math.round((inst.refPrice * inst.dividendYield) / 100);
      events.push({ id: `${inst.symbol}-div-${year}`, symbol: inst.symbol, kind: "dividend", title: `${inst.name} : détachement du dividende`, date: utc(year, divMonth, divDay), detail: `Dividende net estimé ≈ ${dps.toLocaleString("fr-FR")} FCFA par action (rendement ≈ ${inst.dividendYield.toFixed(1)} %).`, indicative: true });
    }
    // publications semestrielles
    events.push({ id: `${inst.symbol}-h1-${year}`, symbol: inst.symbol, kind: "results", title: `${inst.name} : résultats semestriels`, date: utc(year, 8 + (i % 2), 10 + (i % 18)), detail: "Publication des comptes au 30 juin.", indicative: true });
  }
  // événements de place
  events.push({ id: `market-holiday-${year}-1`, symbol: null, kind: "market", title: "BRVM fermée : Jour de l'An", date: utc(year, 1, 1), detail: "Pas de séance de cotation.", indicative: false });
  events.push({ id: `market-holiday-${year}-2`, symbol: null, kind: "market", title: "BRVM fermée : Fête du Travail", date: utc(year, 5, 1), detail: "Pas de séance de cotation.", indicative: false });
  events.push({ id: `market-holiday-${year}-3`, symbol: null, kind: "market", title: "BRVM fermée : Fête de l'Indépendance (Côte d'Ivoire)", date: utc(year, 8, 7), detail: "Pas de séance de cotation.", indicative: false });
  events.push({ id: `market-holiday-${year}-4`, symbol: null, kind: "market", title: "BRVM fermée : Noël", date: utc(year, 12, 25), detail: "Pas de séance de cotation.", indicative: false });
  return events.sort((a, b) => a.date - b.date);
}
