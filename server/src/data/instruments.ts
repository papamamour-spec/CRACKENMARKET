/**
 * Référentiel des valeurs cotées à la BRVM (Bourse Régionale des Valeurs Mobilières).
 * Les prix de référence servent à amorcer l'historique synthétique lorsque le flux
 * temps réel n'est pas disponible. Ils sont exprimés en FCFA (XOF) et correspondent aux
 * clôtures de la cote officielle du 11 novembre 2026 (volumes et rendements nets du bulletin
 * officiel de la même séance) ; la collecte automatique les remplace dès qu'elle tourne.
 */
export interface InstrumentDef {
  symbol: string;
  name: string;
  sector: string;
  country: string; // code pays UEMOA
  refPrice: number; // prix de référence (FCFA)
  volatility: number; // volatilité annualisée approximative
  avgVolume: number; // volume quotidien moyen (titres)
  dividendYield: number; // rendement du dividende (%)
  brvm30: boolean; // membre de l'indice BRVM 30
}

export const INSTRUMENTS: InstrumentDef[] = [
  { symbol: "SNTS", name: "Sonatel", sector: "Télécommunications", country: "SN", refPrice: 4200, volatility: 0.18, avgVolume: 85624, dividendYield: 4.2, brvm30: true },
  { symbol: "ORAC", name: "Orange Côte d'Ivoire", sector: "Télécommunications", country: "CI", refPrice: 20100, volatility: 0.2, avgVolume: 1309, dividendYield: 3.5, brvm30: true },
  { symbol: "ONTBF", name: "Onatel Burkina Faso", sector: "Télécommunications", country: "BF", refPrice: 2900, volatility: 0.24, avgVolume: 3849, dividendYield: 5, brvm30: true },
  { symbol: "ETIT", name: "Ecobank Transnational Inc.", sector: "Banques", country: "TG", refPrice: 59, volatility: 0.35, avgVolume: 658363, dividendYield: 1.5, brvm30: true },
  { symbol: "SGBC", name: "Société Générale Côte d'Ivoire", sector: "Banques", country: "CI", refPrice: 38800, volatility: 0.22, avgVolume: 1126, dividendYield: 6, brvm30: true },
  { symbol: "BOAB", name: "Bank of Africa Bénin", sector: "Banques", country: "BJ", refPrice: 9475, volatility: 0.25, avgVolume: 6593, dividendYield: 6.2, brvm30: true },
  { symbol: "BOABF", name: "Bank of Africa Burkina Faso", sector: "Banques", country: "BF", refPrice: 7945, volatility: 0.26, avgVolume: 2507, dividendYield: 5, brvm30: true },
  { symbol: "BOAC", name: "Bank of Africa Côte d'Ivoire", sector: "Banques", country: "CI", refPrice: 11950, volatility: 0.25, avgVolume: 3943, dividendYield: 5, brvm30: true },
  { symbol: "BOAM", name: "Bank of Africa Mali", sector: "Banques", country: "ML", refPrice: 5890, volatility: 0.27, avgVolume: 536, dividendYield: 5.4, brvm30: false },
  { symbol: "BOAN", name: "Bank of Africa Niger", sector: "Banques", country: "NE", refPrice: 4900, volatility: 0.28, avgVolume: 487, dividendYield: 4.3, brvm30: false },
  { symbol: "BOAS", name: "Bank of Africa Sénégal", sector: "Banques", country: "SN", refPrice: 8230, volatility: 0.26, avgVolume: 8331, dividendYield: 5.5, brvm30: true },
  { symbol: "BICC", name: "BICI Côte d'Ivoire", sector: "Banques", country: "CI", refPrice: 32800, volatility: 0.24, avgVolume: 1180, dividendYield: 3.7, brvm30: true },
  { symbol: "CBIBF", name: "Coris Bank International", sector: "Banques", country: "BF", refPrice: 32500, volatility: 0.23, avgVolume: 437, dividendYield: 2.8, brvm30: true },
  { symbol: "ECOC", name: "Ecobank Côte d'Ivoire", sector: "Banques", country: "CI", refPrice: 15800, volatility: 0.24, avgVolume: 1028, dividendYield: 5, brvm30: true },
  { symbol: "NSBC", name: "NSIA Banque Côte d'Ivoire", sector: "Banques", country: "CI", refPrice: 17000, volatility: 0.25, avgVolume: 1872, dividendYield: 4, brvm30: true },
  { symbol: "ORGT", name: "Oragroup", sector: "Banques", country: "TG", refPrice: 2555, volatility: 0.3, avgVolume: 284, dividendYield: 2.3, brvm30: true },
  { symbol: "SIBC", name: "Société Ivoirienne de Banque", sector: "Banques", country: "CI", refPrice: 8700, volatility: 0.23, avgVolume: 2366, dividendYield: 4.4, brvm30: true },
  { symbol: "SAFC", name: "SAFCA", sector: "Finances", country: "CI", refPrice: 3690, volatility: 0.3, avgVolume: 937, dividendYield: 2.5, brvm30: false },
  { symbol: "PALC", name: "Palm Côte d'Ivoire", sector: "Agriculture", country: "CI", refPrice: 7645, volatility: 0.3, avgVolume: 635, dividendYield: 5.8, brvm30: true },
  { symbol: "SOGC", name: "SOGB", sector: "Agriculture", country: "CI", refPrice: 7600, volatility: 0.28, avgVolume: 453, dividendYield: 6.6, brvm30: true },
  { symbol: "SPHC", name: "SAPH", sector: "Agriculture", country: "CI", refPrice: 8000, volatility: 0.32, avgVolume: 1260, dividendYield: 5.4, brvm30: true },
  { symbol: "SCRC", name: "Sucrivoire", sector: "Agriculture", country: "CI", refPrice: 1600, volatility: 0.33, avgVolume: 10533, dividendYield: 2.5, brvm30: false },
  { symbol: "SICC", name: "SICOR", sector: "Agriculture", country: "CI", refPrice: 8400, volatility: 0.4, avgVolume: 300, dividendYield: 0, brvm30: false },
  { symbol: "TTLC", name: "TotalEnergies Marketing CI", sector: "Distribution", country: "CI", refPrice: 3030, volatility: 0.22, avgVolume: 1644, dividendYield: 4.6, brvm30: true },
  { symbol: "TTLS", name: "TotalEnergies Marketing Sénégal", sector: "Distribution", country: "SN", refPrice: 3700, volatility: 0.24, avgVolume: 2272, dividendYield: 4.8, brvm30: true },
  { symbol: "SHEC", name: "Vivo Energy Côte d'Ivoire", sector: "Distribution", country: "CI", refPrice: 2030, volatility: 0.23, avgVolume: 3243, dividendYield: 4.1, brvm30: true },
  { symbol: "CFAC", name: "CFAO Motors Côte d'Ivoire", sector: "Distribution", country: "CI", refPrice: 1260, volatility: 0.28, avgVolume: 2339, dividendYield: 4.4, brvm30: false },
  { symbol: "PRSC", name: "Tractafric Motors CI", sector: "Distribution", country: "CI", refPrice: 3795, volatility: 0.3, avgVolume: 164, dividendYield: 5.2, brvm30: false },
  { symbol: "BNBC", name: "Bernabé Côte d'Ivoire", sector: "Distribution", country: "CI", refPrice: 1725, volatility: 0.29, avgVolume: 684, dividendYield: 8.4, brvm30: false },
  { symbol: "ABJC", name: "Servair Abidjan", sector: "Services", country: "CI", refPrice: 3300, volatility: 0.3, avgVolume: 1637, dividendYield: 6.1, brvm30: false },
  { symbol: "CIEC", name: "Compagnie Ivoirienne d'Électricité", sector: "Services publics", country: "CI", refPrice: 5100, volatility: 0.21, avgVolume: 4824, dividendYield: 4.2, brvm30: true },
  { symbol: "SDCC", name: "SODECI", sector: "Services publics", country: "CI", refPrice: 12540, volatility: 0.22, avgVolume: 314, dividendYield: 3.7, brvm30: true },
  { symbol: "SDSC", name: "Africa Global Logistics CI", sector: "Transport", country: "CI", refPrice: 2800, volatility: 0.27, avgVolume: 7994, dividendYield: 3.3, brvm30: true },
  { symbol: "NTLC", name: "Nestlé Côte d'Ivoire", sector: "Industrie", country: "CI", refPrice: 12900, volatility: 0.28, avgVolume: 863, dividendYield: 2.8, brvm30: true },
  { symbol: "SLBC", name: "Solibra", sector: "Industrie", country: "CI", refPrice: 41000, volatility: 0.25, avgVolume: 202, dividendYield: 4.7, brvm30: true },
  { symbol: "UNLC", name: "Unilever Côte d'Ivoire", sector: "Industrie", country: "CI", refPrice: 47000, volatility: 0.35, avgVolume: 1500, dividendYield: 0, brvm30: false },
  { symbol: "UNXC", name: "Uniwax", sector: "Industrie", country: "CI", refPrice: 1895, volatility: 0.32, avgVolume: 3029, dividendYield: 3.2, brvm30: false },
  { symbol: "FTSC", name: "Filtisac", sector: "Industrie", country: "CI", refPrice: 1690, volatility: 0.3, avgVolume: 1193, dividendYield: 102.2, brvm30: false },
  { symbol: "SIVC", name: "Air Liquide Côte d'Ivoire", sector: "Industrie", country: "CI", refPrice: 1720, volatility: 0.35, avgVolume: 278, dividendYield: 2.5, brvm30: false },
  { symbol: "STBC", name: "SITAB", sector: "Industrie", country: "CI", refPrice: 21300, volatility: 0.26, avgVolume: 1161, dividendYield: 8.1, brvm30: false },
  { symbol: "SEMC", name: "Crown Siem Côte d'Ivoire", sector: "Industrie", country: "CI", refPrice: 1495, volatility: 0.34, avgVolume: 1200, dividendYield: 0.9, brvm30: false },
  { symbol: "NEIC", name: "NEI-CEDA", sector: "Industrie", country: "CI", refPrice: 1850, volatility: 0.38, avgVolume: 1161, dividendYield: 7.1, brvm30: false },
  { symbol: "CABC", name: "SICABLE", sector: "Industrie", country: "CI", refPrice: 2900, volatility: 0.31, avgVolume: 320, dividendYield: 5.2, brvm30: false },
  { symbol: "SMBC", name: "SMB Côte d'Ivoire", sector: "Industrie", country: "CI", refPrice: 17950, volatility: 0.3, avgVolume: 2425, dividendYield: 3.9, brvm30: false },
  { symbol: "STAC", name: "SETAO", sector: "Industrie", country: "CI", refPrice: 1900, volatility: 0.4, avgVolume: 7605, dividendYield: 3.2, brvm30: false },
  { symbol: "LNBB", name: "Loterie Nationale du Bénin", sector: "Services", country: "BJ", refPrice: 3800, volatility: 0.27, avgVolume: 264, dividendYield: 4.2, brvm30: true },
  { symbol: "BBGC", name: "Bridge Bank Group Côte d'Ivoire", sector: "Banques", country: "CI", refPrice: 9450, volatility: 0.25, avgVolume: 5793, dividendYield: 0, brvm30: false },
  { symbol: "BICB", name: "BIIC Bénin", sector: "Banques", country: "BJ", refPrice: 7980, volatility: 0.25, avgVolume: 15537, dividendYield: 3.15, brvm30: false },
];

export const INSTRUMENT_MAP = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

export const SECTORS = Array.from(new Set(INSTRUMENTS.map((i) => i.sector))).sort();
