/**
 * Référentiel des valeurs cotées à la BRVM (Bourse Régionale des Valeurs Mobilières).
 * Les prix de référence servent à amorcer l'historique synthétique lorsque le flux
 * temps réel n'est pas disponible. Ils sont exprimés en FCFA (XOF).
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
  { symbol: "SNTS", name: "Sonatel", sector: "Télécommunications", country: "SN", refPrice: 22500, volatility: 0.18, avgVolume: 12000, dividendYield: 7.2, brvm30: true },
  { symbol: "ORAC", name: "Orange Côte d'Ivoire", sector: "Télécommunications", country: "CI", refPrice: 13500, volatility: 0.2, avgVolume: 5000, dividendYield: 5.8, brvm30: true },
  { symbol: "ONTBF", name: "Onatel Burkina Faso", sector: "Télécommunications", country: "BF", refPrice: 2800, volatility: 0.24, avgVolume: 8000, dividendYield: 8.5, brvm30: true },
  { symbol: "ETIT", name: "Ecobank Transnational Inc.", sector: "Banques", country: "TG", refPrice: 20, volatility: 0.35, avgVolume: 900000, dividendYield: 4.1, brvm30: true },
  { symbol: "SGBC", name: "Société Générale Côte d'Ivoire", sector: "Banques", country: "CI", refPrice: 21000, volatility: 0.22, avgVolume: 3000, dividendYield: 6.0, brvm30: true },
  { symbol: "BOAB", name: "Bank of Africa Bénin", sector: "Banques", country: "BJ", refPrice: 5200, volatility: 0.25, avgVolume: 4000, dividendYield: 9.0, brvm30: true },
  { symbol: "BOABF", name: "Bank of Africa Burkina Faso", sector: "Banques", country: "BF", refPrice: 4800, volatility: 0.26, avgVolume: 3500, dividendYield: 8.7, brvm30: true },
  { symbol: "BOAC", name: "Bank of Africa Côte d'Ivoire", sector: "Banques", country: "CI", refPrice: 5100, volatility: 0.25, avgVolume: 3800, dividendYield: 8.9, brvm30: true },
  { symbol: "BOAM", name: "Bank of Africa Mali", sector: "Banques", country: "ML", refPrice: 3300, volatility: 0.27, avgVolume: 2500, dividendYield: 8.0, brvm30: false },
  { symbol: "BOAN", name: "Bank of Africa Niger", sector: "Banques", country: "NE", refPrice: 3200, volatility: 0.28, avgVolume: 2200, dividendYield: 8.2, brvm30: false },
  { symbol: "BOAS", name: "Bank of Africa Sénégal", sector: "Banques", country: "SN", refPrice: 3600, volatility: 0.26, avgVolume: 3000, dividendYield: 8.3, brvm30: true },
  { symbol: "BICC", name: "BICI Côte d'Ivoire", sector: "Banques", country: "CI", refPrice: 9500, volatility: 0.24, avgVolume: 1500, dividendYield: 4.5, brvm30: true },
  { symbol: "CBIBF", name: "Coris Bank International", sector: "Banques", country: "BF", refPrice: 12500, volatility: 0.23, avgVolume: 2000, dividendYield: 6.5, brvm30: true },
  { symbol: "ECOC", name: "Ecobank Côte d'Ivoire", sector: "Banques", country: "CI", refPrice: 8500, volatility: 0.24, avgVolume: 2500, dividendYield: 7.0, brvm30: true },
  { symbol: "NSBC", name: "NSIA Banque Côte d'Ivoire", sector: "Banques", country: "CI", refPrice: 8000, volatility: 0.25, avgVolume: 2800, dividendYield: 5.5, brvm30: true },
  { symbol: "ORGT", name: "Oragroup", sector: "Banques", country: "TG", refPrice: 2200, volatility: 0.3, avgVolume: 6000, dividendYield: 3.0, brvm30: true },
  { symbol: "SIBC", name: "Société Ivoirienne de Banque", sector: "Banques", country: "CI", refPrice: 6500, volatility: 0.23, avgVolume: 3500, dividendYield: 7.5, brvm30: true },
  { symbol: "SAFC", name: "SAFCA", sector: "Finances", country: "CI", refPrice: 1600, volatility: 0.3, avgVolume: 1200, dividendYield: 2.5, brvm30: false },
  { symbol: "PALC", name: "Palm Côte d'Ivoire", sector: "Agriculture", country: "CI", refPrice: 7200, volatility: 0.3, avgVolume: 4000, dividendYield: 6.8, brvm30: true },
  { symbol: "SOGC", name: "SOGB", sector: "Agriculture", country: "CI", refPrice: 5500, volatility: 0.28, avgVolume: 2500, dividendYield: 7.0, brvm30: true },
  { symbol: "SPHC", name: "SAPH", sector: "Agriculture", country: "CI", refPrice: 4200, volatility: 0.32, avgVolume: 3000, dividendYield: 5.0, brvm30: true },
  { symbol: "SCRC", name: "Sucrivoire", sector: "Agriculture", country: "CI", refPrice: 900, volatility: 0.33, avgVolume: 5000, dividendYield: 4.0, brvm30: false },
  { symbol: "SICC", name: "SICOR", sector: "Agriculture", country: "CI", refPrice: 3500, volatility: 0.4, avgVolume: 300, dividendYield: 0, brvm30: false },
  { symbol: "TTLC", name: "TotalEnergies Marketing CI", sector: "Distribution", country: "CI", refPrice: 2600, volatility: 0.22, avgVolume: 8000, dividendYield: 6.2, brvm30: true },
  { symbol: "TTLS", name: "TotalEnergies Marketing Sénégal", sector: "Distribution", country: "SN", refPrice: 2300, volatility: 0.24, avgVolume: 3000, dividendYield: 6.0, brvm30: true },
  { symbol: "SHEC", name: "Vivo Energy Côte d'Ivoire", sector: "Distribution", country: "CI", refPrice: 950, volatility: 0.23, avgVolume: 15000, dividendYield: 7.8, brvm30: true },
  { symbol: "CFAC", name: "CFAO Motors Côte d'Ivoire", sector: "Distribution", country: "CI", refPrice: 900, volatility: 0.28, avgVolume: 4000, dividendYield: 5.5, brvm30: false },
  { symbol: "PRSC", name: "Tractafric Motors CI", sector: "Distribution", country: "CI", refPrice: 2400, volatility: 0.3, avgVolume: 800, dividendYield: 3.5, brvm30: false },
  { symbol: "BNBC", name: "Bernabé Côte d'Ivoire", sector: "Distribution", country: "CI", refPrice: 1800, volatility: 0.29, avgVolume: 1500, dividendYield: 4.5, brvm30: false },
  { symbol: "ABJC", name: "Servair Abidjan", sector: "Services", country: "CI", refPrice: 2000, volatility: 0.3, avgVolume: 1000, dividendYield: 6.0, brvm30: false },
  { symbol: "CIEC", name: "Compagnie Ivoirienne d'Électricité", sector: "Services publics", country: "CI", refPrice: 2600, volatility: 0.21, avgVolume: 6000, dividendYield: 6.5, brvm30: true },
  { symbol: "SDCC", name: "SODECI", sector: "Services publics", country: "CI", refPrice: 5500, volatility: 0.22, avgVolume: 1500, dividendYield: 5.5, brvm30: true },
  { symbol: "SDSC", name: "Africa Global Logistics CI", sector: "Transport", country: "CI", refPrice: 2200, volatility: 0.27, avgVolume: 4000, dividendYield: 4.8, brvm30: true },
  { symbol: "NTLC", name: "Nestlé Côte d'Ivoire", sector: "Industrie", country: "CI", refPrice: 7500, volatility: 0.28, avgVolume: 2000, dividendYield: 3.9, brvm30: true },
  { symbol: "SLBC", name: "Solibra", sector: "Industrie", country: "CI", refPrice: 20500, volatility: 0.25, avgVolume: 800, dividendYield: 5.2, brvm30: true },
  { symbol: "UNLC", name: "Unilever Côte d'Ivoire", sector: "Industrie", country: "CI", refPrice: 5000, volatility: 0.35, avgVolume: 1500, dividendYield: 0, brvm30: false },
  { symbol: "UNXC", name: "Uniwax", sector: "Industrie", country: "CI", refPrice: 1300, volatility: 0.32, avgVolume: 3000, dividendYield: 2.0, brvm30: false },
  { symbol: "FTSC", name: "Filtisac", sector: "Industrie", country: "CI", refPrice: 2500, volatility: 0.3, avgVolume: 2000, dividendYield: 5.0, brvm30: false },
  { symbol: "SIVC", name: "Air Liquide Côte d'Ivoire", sector: "Industrie", country: "CI", refPrice: 800, volatility: 0.35, avgVolume: 2500, dividendYield: 2.5, brvm30: false },
  { symbol: "STBC", name: "SITAB", sector: "Industrie", country: "CI", refPrice: 4500, volatility: 0.26, avgVolume: 800, dividendYield: 8.0, brvm30: false },
  { symbol: "SEMC", name: "Crown Siem Côte d'Ivoire", sector: "Industrie", country: "CI", refPrice: 1200, volatility: 0.34, avgVolume: 1200, dividendYield: 3.0, brvm30: false },
  { symbol: "NEIC", name: "NEI-CEDA", sector: "Industrie", country: "CI", refPrice: 700, volatility: 0.38, avgVolume: 2000, dividendYield: 0, brvm30: false },
  { symbol: "CABC", name: "SICABLE", sector: "Industrie", country: "CI", refPrice: 1500, volatility: 0.31, avgVolume: 1800, dividendYield: 4.0, brvm30: false },
  { symbol: "SMBC", name: "SMB Côte d'Ivoire", sector: "Industrie", country: "CI", refPrice: 9000, volatility: 0.3, avgVolume: 700, dividendYield: 4.2, brvm30: false },
  { symbol: "STAC", name: "SETAO", sector: "Industrie", country: "CI", refPrice: 1100, volatility: 0.4, avgVolume: 800, dividendYield: 0, brvm30: false },
  { symbol: "LNBB", name: "Loterie Nationale du Bénin", sector: "Services", country: "BJ", refPrice: 6000, volatility: 0.27, avgVolume: 3000, dividendYield: 7.5, brvm30: true },
];

export const INSTRUMENT_MAP = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

export const SECTORS = Array.from(new Set(INSTRUMENTS.map((i) => i.sector))).sort();
