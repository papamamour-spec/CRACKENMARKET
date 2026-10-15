export interface Quote {
  symbol: string;
  name: string;
  sector: string;
  country: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  change: number;
  changePct: number;
  volume: number;
  value: number;
  ts: number;
  source: "live" | "simulation";
  brvm30: boolean;
  perf: Record<Period, number | null>;
  high52: number;
  low52: number;
}
export type Period = "1D" | "1W" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "3Y" | "5Y";
export const PERIODS: Period[] = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y"];
export const PERIOD_LABEL: Record<Period, string> = { "1D": "Veille", "1W": "1 sem.", "1M": "1 mois", "3M": "3 mois", "6M": "6 mois", YTD: "Année", "1Y": "1 an", "3Y": "3 ans", "5Y": "5 ans" };
export interface IndexSnapshot {
  name: string;
  value: number;
  changePct: number;
  ts: number;
}
export interface MarketStatus {
  provider: "live" | "simulation";
  open: boolean;
  serverTime: number;
  nextOpen: number;
  nextClose: number;
}
export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface SeriesPoint {
  time: number;
  value: number;
}
export interface HistoryResponse {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  indicators: Record<string, SeriesPoint[]> | null;
}
export interface User {
  id: number;
  email: string;
  fullName: string;
  role: string;
  referralCode?: string;
  points?: number;
  totpEnabled?: boolean;
  publicProfile?: boolean;
}
export interface DeclaredProfile {
  riskTolerance: number;
  horizonMonths: number;
  objective: "income" | "growth" | "balanced" | "speculative";
  experience: "beginner" | "intermediate" | "expert";
  monthlyCapacity: number;
  preferredSectors: string[];
}
export interface BehaviorBias {
  code: string;
  severity: number;
  title: string;
  description: string;
  advice: string;
}
export interface BehaviorProfile {
  effectiveRiskTolerance: number;
  declared: DeclaredProfile;
  tradesPerMonth: number;
  winRate: number;
  avgHoldingDays: number;
  totalRealizedPnl: number;
  biases: BehaviorBias[];
  disciplineScore: number;
  style: string;
}
export interface Recommendation {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  action: string;
  score: number;
  confidence: number;
  fitScore: number;
  targetPrice: number;
  stopLoss: number;
  suggestedQuantity: number;
  suggestedAmount: number;
  expectedReturnPct: number;
  riskRewardRatio: number;
  horizon: string;
  rationale: string[];
  warnings: string[];
  dividendYield: number;
  held: boolean;
}
export interface Technical {
  symbol: string;
  price: number;
  updatedAt?: number;
  sma20: number;
  sma50: number;
  sma200: number;
  rsi14: number;
  macd: number;
  macdSignal: number;
  macdHist: number;
  bollUpper: number;
  bollLower: number;
  atr14: number;
  stochK: number;
  volatility60: number;
  maxDrawdown250: number;
  sharpe250: number;
  perf1w: number;
  perf1m: number;
  perf3m: number;
  perf6m: number;
  perf1y: number;
  volumeRatio: number;
  support: number;
  resistance: number;
  scores: { trend: number; momentum: number; meanReversion: number; volume: number; risk: number; composite: number };
  signals: string[];
}
export interface Position {
  symbol: string;
  name: string;
  sector: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  marketValue: number;
  costBasis: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  weightPct: number;
  dayChangePct: number;
}
export interface PortfolioSummary {
  portfolio: { id: number; name: string; cash: number; initialCash: number };
  positions: Position[];
  invested: number;
  totalValue: number;
  totalPnl: number;
  totalPnlPct: number;
  realizedPnl: number;
  unrealizedPnl: number;
}
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export interface Order {
  id: number;
  symbol: string;
  side: "buy" | "sell";
  type: OrderType;
  quantity: number;
  limit_price: number | null;
  stop_price: number | null;
  validity: "day" | "gtc";
  oco_group: string | null;
  take_profit: number | null;
  stop_loss: number | null;
  triggered_at: number | null;
  status: string;
  filled_price: number | null;
  created_at: number;
  note: string | null;
}
export interface Diagnostic {
  totalValue: number;
  cash: number;
  invested: number;
  cashRatio: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  lines: number;
  sectorExposure: { sector: string; weightPct: number }[];
  diversificationScore: number;
  riskScore: number;
  healthScore: number;
  suggestions: string[];
  rebalancing: { symbol: string; action: string; reason: string; weightPct: number }[];
}
export interface Allocation {
  symbol: string;
  name: string;
  weightPct: number;
  amount: number;
  quantity: number;
}
export interface ScreenerRow {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  changePct: number;
  composite: number;
  trend: number;
  momentum: number;
  rsi: number;
  volatility: number;
  perf1m: number;
  perf1y: number;
  dividendYield: number;
  signals: string[];
}
export interface Alert {
  id: number;
  symbol: string;
  condition: "above" | "below" | "pct_move";
  value: number;
  active: number;
  triggered_at: number | null;
  created_at: number;
}
export interface BacktestResult {
  strategy: string;
  symbol: string;
  initialCapital: number;
  finalEquity: number;
  totalReturnPct: number;
  buyHoldReturnPct: number;
  trades: number;
  winRate: number;
  maxDrawdownPct: number;
  equityCurve: SeriesPoint[];
  signals: { time: number; side: "buy" | "sell"; price: number }[];
}

export interface BookLevel {
  price: number;
  quantity: number;
  orders: number;
}
export interface OrderBook {
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  spread: number;
  spreadPct: number;
  imbalance: number;
  ts: number;
  estimated: boolean;
}
export interface Signal {
  id: number;
  symbol: string;
  kind: "bullish" | "bearish" | "neutral";
  message: string;
  price: number;
  ts: number;
}
export interface MarketEvent {
  id: string;
  symbol: string | null;
  kind: "dividend" | "agm" | "results" | "market";
  title: string;
  date: number;
  detail: string;
  indicative: boolean;
}
export interface LeaderboardEntry {
  userId: number;
  displayName: string;
  role: string;
  totalReturnPct: number;
  monthReturnPct: number;
  lines: number;
  trades: number;
  points: number;
  followers: number;
  isFollowed: boolean;
  topHoldings: string[];
}
export interface PerformanceStats {
  totalReturnPct: number;
  benchmarkReturnPct: number;
  volatilityPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  trades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  realizedPnl: number;
  unrealizedPnl: number;
  feesPaid: number;
}
export interface Performance {
  series: { time: number; value: number; portfolioPct: number; benchmarkPct: number }[];
  stats: PerformanceStats;
}
export interface PublicProfile {
  userId: number;
  displayName: string;
  role: string;
  points: number;
  memberSince: number;
  followers: number;
  isFollowed: boolean;
  totalReturnPct: number;
  allocation: { symbol: string; sector: string; weightPct: number }[];
  cashPct: number;
  curve: { time: number; portfolioPct: number; benchmarkPct: number }[];
  stats: PerformanceStats;
  recentTrades: { symbol: string; side: "buy" | "sell"; ts: number; resultPct: number | null }[];
}
export interface ApiKey {
  id: number;
  label: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}
export interface Referrals {
  user: User;
  referred: { fullName: string; createdAt: number }[];
  ledger: { points: number; reason: string; ts: number }[];
  rewards: Record<string, number>;
}

export interface SgiPartner {
  code: string;
  name: string;
  shortName: string;
  country: string;
  city: string;
  website: string;
  email: string;
  phone: string;
  channel: "console" | "webhook";
  channelLabel: string;
  brokerageFeePct: number;
  minFee: number;
  marketFeePct: number;
  feesConfirmed: boolean;
  requiredDocuments: string[];
  onboardingDelay: string;
  featured: boolean;
}
export type SgiAccountStatus = "pending" | "verified" | "rejected";
export interface SgiAccount {
  id: number;
  user_id: number;
  sgi_code: string;
  status: SgiAccountStatus;
  account_number: string | null;
  holder_name: string;
  id_type: string;
  id_number: string;
  phone: string;
  address: string;
  country: string;
  note: string | null;
  created_at: number;
  updated_at: number;
  client_email?: string;
}
export type SgiOrderStatus = "pending" | "transmitted" | "acknowledged" | "executed" | "partial" | "rejected" | "cancelled";
export interface SgiOrder {
  id: number;
  user_id: number;
  sgi_code: string;
  account_number: string | null;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: number;
  limit_price: number | null;
  validity: "day" | "week" | "gtc";
  status: SgiOrderStatus;
  executed_qty: number;
  executed_price: number | null;
  sgi_reference: string | null;
  estimated_amount: number;
  estimated_fees: number;
  note: string | null;
  created_at: number;
  updated_at: number;
  client_name?: string;
  client_email?: string;
}
export const SGI_STATUS_LABEL: Record<SgiOrderStatus, string> = {
  pending: "En attente de transmission",
  transmitted: "Transmis à la SGI",
  acknowledged: "Pris en charge par la SGI",
  executed: "Exécuté",
  partial: "Partiellement exécuté",
  rejected: "Rejeté",
  cancelled: "Annulé",
};

export interface AllocationLine {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  quantity: number;
  amount: number;
  weightPct: number;
  dividendYield: number;
  expectedReturnPct: number;
  fitScore: number;
  rationale: string[];
}
export interface AdvisoryReport {
  generatedAt: number;
  style: string;
  capital: number;
  investable: number;
  cashReserve: number;
  cashReservePct: number;
  allocation: AllocationLine[];
  sectorBreakdown: { sector: string; weightPct: number }[];
  metrics: {
    lines: number;
    expectedDividendYieldPct: number;
    expectedReturnPct: number;
    annualizedReturnPct: number;
    estimatedVolatilityPct: number;
    maxLineWeightPct: number;
    annualDividendIncome: number;
  };
  scenarios: { pessimistic: number; central: number; optimistic: number; horizonMonths: number };
  existing: { diagnostic: Diagnostic; actions: Diagnostic["rebalancing"] } | null;
  newsContext?: { marketSentiment: number; marketCount: number; headlines: { title: string; sentiment: number; source: string; url: string; published_at: number }[] };
  optimization?: OptimizationSummary;
  forecasts?: LineForecast[];
  bonds?: BondSleeve;
  summary: string[];
  warnings: string[];
}
export interface OptimizationSummary {
  method: "optimizer" | "heuristic";
  targetYieldPct: number | null;
  reachedTarget: boolean;
  maxAchievablePct: number;
  expectedAnnualReturnPct: number;
  volatilityPct: number;
  sharpe: number;
  dividendYieldPct: number;
  minVolatilityPct: number;
  riskFreePct: number;
  constraints: { maxWeightPct: number; maxSectorWeightPct: number; maxLines: number; investedMaxPct: number; excludedSectors: string[]; excludedSymbols: string[] };
  frontier: { targetReturnPct: number; volatilityPct: number; expectedReturnPct: number }[];
  notes: string[];
}
export interface LineForecast {
  symbol: string;
  expectedReturn3MPct: number;
  probUp3M: number;
  hitRate3M: number;
  p5: number;
  p95: number;
  explanation: string | null;
}
export type Horizon = "1W" | "1M" | "3M";
export const HORIZON_LABEL: Record<Horizon, string> = { "1W": "1 semaine", "1M": "1 mois", "3M": "3 mois" };
export interface Contribution { factor: string; label: string; value: number; contributionPct: number }
export interface HorizonForecast {
  horizon: Horizon;
  horizonDays: number;
  expectedReturnPct: number;
  probUp: number;
  probAbove5: number;
  probBelow5: number;
  quantiles: { p5: number; p25: number; p50: number; p75: number; p95: number };
  priceTargets: { p5: number; p50: number; p95: number };
  accuracy: { hitRate: number; baselineHitRate: number; maePct: number; naiveMaePct: number; samples: number };
  confidence: number;
  models: { ridgePct: number; arPct: number; newsAdjustmentPct: number; weights: { ridge: number; ar: number } };
  learning: { version: number; resolved: number; liveHitRate: number | null; liveMaePct: number | null; coverage90: number | null; brier: number | null; lambda: number; volScale: number; biasPct: number; newsFactor: number; modelErr: { ridge: number | null; ar: number | null }; updatedAt: number };
  contributions: Contribution[];
  explanations: string[];
}
export interface Forecast { symbol: string; price: number; generatedAt: number; dailyVolPct: number; horizons: HorizonForecast[]; summary: string }
export interface ForecastSummary {
  symbol: string; name: string; sector: string; price: number; dailyVolPct: number; generatedAt: number;
  horizons: Record<Horizon, { expectedReturnPct: number; probUp: number; hitRate: number; baselineHitRate: number; confidence: number; p5: number; p95: number; liveHitRate: number | null; resolved: number }>;
  summary: string; topExplanation: string | null;
}
export interface LearningStats { horizon: Horizon; pending: number; resolved: number; hitRate: number | null; maePct: number | null; coverage90: number | null; brier: number | null; naiveHitRate: number | null; naiveMaePct: number | null }
export interface LearningSummary {
  totalResolved: number;
  totalPending: number;
  lastCycleAt: number | null;
  nextCycleAt: number | null;
  backfill: { done: boolean; sessions: number } | null;
  byHorizon: LearningStats[];
  monthly: { month: string; horizon: Horizon; resolved: number; hitRate: number; maePct: number }[];
  recentAdjustments: { symbol: string; horizon: Horizon; version: number; volScale: number; biasPct: number; newsFactor: number; lambda: number; resolved: number; updatedAt: number }[];
}
export interface ForecastLogRow { id: number; symbol: string; horizon: Horizon; made_at: number; made_day: string; price: number; expected_pct: number; prob_up: number; p5: number; p95: number; source: "live" | "backfill"; realized_pct: number | null; hit: number | null; abs_err: number | null; covered: number | null; resolved_at: number | null }
export interface ForecastRanking { items: ForecastSummary[]; ready: number; total: number; horizon: Horizon }
export type AdvisoryStatus = "generated" | "validated" | "declined";
export interface AdvisoryView {
  id: number;
  user_id: number;
  requester_type: "client" | "sgi";
  sgi_code: string | null;
  client_label: string | null;
  capital: number;
  objective: string;
  horizon_months: number;
  risk_tolerance: number;
  preferred_sectors: string[];
  constraints: string | null;
  holdings: { symbol: string; quantity: number; avgPrice?: number }[];
  status: AdvisoryStatus;
  report: AdvisoryReport;
  analyst_id: number | null;
  analyst_note: string | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
  requester_name?: string;
  requester_email?: string;
}
export const ADVISORY_STATUS_LABEL: Record<AdvisoryStatus, string> = {
  generated: "Proposition Kraken générée",
  validated: "Validée par un analyste",
  declined: "Non retenue par l'analyste",
};

export interface NewsView {
  id: number;
  source: string;
  title: string;
  url: string;
  summary: string | null;
  published_at: number;
  symbols: string[];
  sentiment: number;
  market_wide: number;
  fetched_at: number;
}
export interface NewsSentiment {
  score: number;
  count: number;
  headlines: { title: string; sentiment: number; source: string; url: string; published_at: number }[];
}
export interface SourceStatus { name: string; url: string; kind: string; weight: number; category: string; lastAt: number | null; ok: boolean | null; parsed: number; inserted: number; error: string | null }
export interface NewsResponse {
  items: NewsView[];
  market: NewsSentiment;
  symbolSentiment: NewsSentiment | null;
  status: { sources: string[]; items: number; lastRun: { at: number; ok: string[]; failed: string[] } | null; details?: SourceStatus[] };
}

// ---- Portefeuille détenu (saisi) ----
export interface HeldPosition { symbol: string; quantity: number; avgPrice: number | null; acquiredAt: number | null; note: string | null }
export interface HeldPortfolio { label: string | null; cash: number; positions: HeldPosition[]; updatedAt: number | null }
export type LineAction = "renforcer" | "conserver" | "alléger" | "vendre";
export interface AnalysisLine {
  symbol: string; name: string; sector: string; quantity: number; avgPrice: number | null; price: number; value: number; cost: number | null; pnl: number | null; pnlPct: number | null; weightPct: number; dividendYield: number; annualDividend: number;
  perf: Record<string, number | null> | null;
  recommendation: { action: string; score: number; confidence: number; fitScore: number; targetPrice: number; stopLoss: number; rationale: string[]; warnings: string[] };
  forecast: { expected1M: number; probUp1M: number; expected3M: number; probUp3M: number; p5: number; p95: number; liveHitRate: number | null } | null;
  action: { kind: LineAction; quantity: number; amount: number; reasons: string[] };
}
export interface PortfolioAnalysis {
  generatedAt: number;
  profileStyle: string;
  totals: { invested: number; cost: number | null; pnl: number | null; pnlPct: number | null; cash: number; total: number; cashPct: number; annualDividendIncome: number; dividendYieldPct: number; lines: number; sectors: number; bondsValue: number; annualCouponIncome: number; annualIncome: number };
  lines: AnalysisLine[];
  bondLines: BondLine[];
  assetClasses: { equitiesPct: number; bondsPct: number; cashPct: number };
  bondSleeve: { currentPct: number; targetPct: number; gapAmount: number; avgYieldPct: number | null; durationYears: number | null; suggestions: BondAllocationLine[]; verdict: string };
  incomeCalendar: { date: number; code: string; kind: "coupon" | "remboursement"; amount: number }[];
  unknownSymbols: string[];
  diagnostic: Diagnostic;
  risk: { volatilityPct: number; beta: number | null; maxDrawdown1yPct: number; var95_1mPct: number; var95_1m: number; topWeightPct: number; hhi: number; concentrationLabel: string };
  forecast: { expected1MPct: number; expected3MPct: number; probUp1M: number; probUp3M: number; amount1M: number; amount3M: number };
  performance: { portfolioPct: Record<string, number | null>; indexPct: Record<string, number | null> };
  target: { method: string; expectedAnnualReturnPct: number; volatilityPct: number; sharpe: number; currentExpectedAnnualReturnPct: number; currentSharpe: number; trades: { symbol: string; name: string; side: "acheter" | "vendre"; quantity: number; amount: number; fromPct: number; toPct: number }[]; keep: { symbol: string; weightPct: number }[] } | null;
  actions: { priority: number; title: string; detail: string; kind: LineAction | "diversifier" | "liquidités" | "initier" | "obligations" }[];
  summary: string[];
  warnings: string[];
}

// ---- Obligations ----
export type IssuerType = "souverain" | "supranational" | "entreprise";
export interface BondView {
  code: string; name: string; issuer: string; issuerType: IssuerType; country: string; couponPct: number; issueDate: string; maturityDate: string; nominal: number; frequency: number; amortization: "in_fine" | "constant" | "annuite"; graceYears: number; taxExempt: boolean; active: boolean;
  quote: { code: string; price: number; ytmPct: number; changePct: number; ts: number; source: "simulation" | "manuel" };
  analytics: { cleanPrice: number; dirtyPrice: number; accrued: number; ytmPct: number; currentYieldPct: number; macaulayYears: number; modifiedDuration: number; convexity: number; dv01: number; remainingYears: number; outstanding: number; annualCoupon: number; nextCoupon: { date: number; amount: number } | null; nextPrincipal: { date: number; amount: number } | null };
}
export interface BondDetail extends BondView {
  schedule: { date: number; coupon: number; principal: number; outstandingAfter: number }[];
  flows: { date: number; years: number; coupon: number; principal: number; outstandingAfter: number }[];
}
export interface BondAllocationLine { code: string; name: string; issuer: string; issuerType: IssuerType; price: number; accrued: number; quantity: number; amount: number; weightPct: number; couponPct: number; ytmPct: number; durationYears: number; remainingYears: number; maturityDate: string; annualCoupon: number; taxExempt: boolean; rationale: string }
export interface BondSleeve { targetSharePct: number; sharePct: number; amount: number; lines: BondAllocationLine[]; annualCoupons: number; avgYieldPct: number; avgDurationYears: number; rationale: string[] }
export interface BondLine {
  code: string; name: string; issuer: string; issuerType: string; quantity: number; avgPrice: number | null; price: number; accrued: number; value: number; cost: number | null; pnl: number | null; weightPct: number; couponPct: number; ytmPct: number; currentYieldPct: number; durationYears: number; remainingYears: number; maturityDate: string; outstanding: number; nextCoupon: { date: number; amount: number } | null; annualCoupon: number; taxExempt: boolean; perf1M: number | null;
  action: { kind: LineAction; quantity: number; amount: number; reasons: string[] };
}
export const ISSUER_LABEL: Record<IssuerType, string> = { souverain: "État", supranational: "Supranational", entreprise: "Entreprise" };
export const AMORT_LABEL: Record<string, string> = { in_fine: "In fine", constant: "Amortissement constant", annuite: "Annuités constantes" };
