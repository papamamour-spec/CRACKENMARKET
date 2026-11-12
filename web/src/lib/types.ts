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
  adjusted?: boolean;
  adjustments?: AdjustmentStep[];
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
  /** meilleures limites officielles (bulletin de la cote) de la dernière séance collectée */
  official?: { bid: number | null; bidQty: number | null; ask: number | null; askQty: number | null; ts: number; source: string };
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
  risk?: RiskReport | null;
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
  returnModel: "black_litterman" | "views";
  blackLitterman: { delta: number; tau: number; lines: BLLine[]; skipped: string[] } | null;
  netExpectedAnnualReturnPct?: number;
  riskModel?: "factoriel" | "échantillon";
}
export interface StressScenario { key: string; label: string; kind: "historique" | "choc" | "taux"; equityPct: number; bondPct: number; totalPct: number; amount: number; window: { from: number; to: number; indexPct: number } | null; lines: { symbol: string; pct: number; contributionPct: number }[]; note: string }
export interface RiskReport {
  model: { kind: "factoriel" | "échantillon"; factors: string[]; observations: number; avgR2: number; blendPct: number };
  loss: { cvar95_1mPct: number; var95_1mPct: number; maxDrawdownPct: number; limitPct: number | null; limited: boolean; amount: number };
  liquidity: { participationPct: number; exitDays: number; capped: { symbol: string; capPct: number }[]; lines: { symbol: string; daysToExit: number; dailyValue: number }[] };
  costs: { entryCost: number; entryPct: number; oneWayPct: number; roundTripPct: number; annualDragPct: number; turnoverPct: number; dividendTax: { country: string; pct: number }[]; fees: { brokeragePct: number; brvmPct: number; dcbrPct: number; vatPct: number; minFee: number } };
  stress: StressScenario[];
}
export interface TrackedStats { days: number; sessions: number; value: number; valueNet: number; returnPct: number; returnNetPct: number; compositePct: number; brvm30Pct: number; alphaCompositePct: number; alphaBrvm30Pct: number; annualizedPct: number | null; maxDrawdownPct: number; volatilityPct: number | null; beatRate: number | null }
export interface TrackedPortfolio { id: number; kind: "conseil" | "cible" | "manuel"; label: string; createdAt: number; startTs: number; capital: number; cash: number; entryCost: number; lines: { symbol: string; weightPct: number; price: number; quantity: number; amount: number }[]; sourceId: number | null; stats: TrackedStats }
export interface TrackedView extends TrackedPortfolio { series: { time: number; value: number; portfolioPct: number; benchmarkPct: number; brvm30Pct: number }[] }
export interface BLLine { symbol: string; marketWeightPct: number; equilibriumPct: number; viewPct: number; posteriorPct: number; confidence: number; viewSharePct: number }
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
  models: { ridgePct: number; arPct: number; panelPct: number | null; newsAdjustmentPct: number; weights: { ridge: number; ar: number; panel: number } };
  panelContributions: Contribution[] | null;
  learning: { version: number; resolved: number; liveHitRate: number | null; liveMaePct: number | null; coverage90: number | null; brier: number | null; lambda: number; volScale: number; biasPct: number; newsFactor: number; modelErr: { ridge: number | null; ar: number | null }; updatedAt: number };
  contributions: Contribution[];
  explanations: string[];
  dividendInHorizon: { exDate: number; amount: number; pct: number } | null;
}
export interface Forecast { symbol: string; price: number; generatedAt: number; dailyVolPct: number; horizons: HorizonForecast[]; summary: string }
export interface ForecastSummary {
  symbol: string; name: string; sector: string; price: number; dailyVolPct: number; generatedAt: number;
  horizons: Record<Horizon, { expectedReturnPct: number; probUp: number; hitRate: number; baselineHitRate: number; confidence: number; p5: number; p95: number; liveHitRate: number | null; resolved: number }>;
  summary: string; topExplanation: string | null;
}
export interface LearningStats { horizon: Horizon; pending: number; resolved: number; hitRate: number | null; maePct: number | null; coverage90: number | null; brier: number | null; naiveHitRate: number | null; naiveMaePct: number | null; rankIC: number | null; rankICt: number | null; rankICDays: number }
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
  quality: { score: number; band: string; confidence: number; headline: string } | null;
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
  risk: { volatilityPct: number; beta: number | null; maxDrawdown1yPct: number; var95_1mPct: number; var95_1m: number; cvar95_1mPct?: number; cvar95_1m?: number; cvarLimitPct?: number; topWeightPct: number; hhi: number; concentrationLabel: string };
  riskReport?: RiskReport | null;
  forecast: { expected1MPct: number; expected3MPct: number; probUp1M: number; probUp3M: number; amount1M: number; amount3M: number };
  performance: { portfolioPct: Record<string, number | null>; indexPct: Record<string, number | null> };
  target: { method: string; expectedAnnualReturnPct: number; volatilityPct: number; sharpe: number; currentExpectedAnnualReturnPct: number; currentSharpe: number; trades: { symbol: string; name: string; side: "acheter" | "vendre"; quantity: number; amount: number; fromPct: number; toPct: number; bandPct?: number; cost?: number }[]; keep: { symbol: string; weightPct: number }[]; returnModel?: "black_litterman"; blackLitterman?: { delta: number; lines: BLLine[] }; netExpectedAnnualReturnPct?: number; costDragPct?: number; turnoverPct?: number; riskModel?: string; cvar95_1mPct?: number; cvarLimited?: boolean; liquidityCapped?: { symbol: string; capPct: number }[]; rebalancing?: { policy: { absolute: number; relative: number; minTrade: number; reviewMonths: number }; withinBand: { symbol: string; currentPct: number; targetPct: number; bandPct: number }[]; turnoverPct: number; estimatedCost: number; nextReview: number }; weights?: { symbol: string; weightPct: number }[] } | null;
  actions: { priority: number; title: string; detail: string; kind: LineAction | "diversifier" | "liquidités" | "initier" | "obligations" }[];
  summary: string[];
  warnings: string[];
}

// ---- Obligations ----
export type IssuerType = "souverain" | "supranational" | "entreprise";
export interface BondView {
  code: string; name: string; issuer: string; issuerType: IssuerType; country: string; couponPct: number; issueDate: string; maturityDate: string; nominal: number; frequency: number; amortization: "in_fine" | "constant" | "annuite"; graceYears: number; taxExempt: boolean; active: boolean; datesEstimated?: boolean; source: "seed" | "brvm" | "admin";
  quote: { code: string; price: number; pricePct: number; ytmPct: number; changePct: number; volume: number; suspended: boolean; ts: number; source: "brvm" | "admin" | "simulation" };
  analytics: { cleanPrice: number; dirtyPrice: number; accrued: number; ytmPct: number; currentYieldPct: number; macaulayYears: number; modifiedDuration: number; convexity: number; dv01: number; remainingYears: number; outstanding: number; annualCoupon: number; nextCoupon: { date: number; amount: number } | null; nextPrincipal: { date: number; amount: number } | null };
}
export interface BondDetail extends BondView {
  schedule: { date: number; coupon: number; principal: number; outstandingAfter: number }[];
  flows: { date: number; years: number; coupon: number; principal: number; outstandingAfter: number }[];
}
export interface BondSourceStatus { sources: string[]; snapshotDate: string; lastRun: { at: number; ok: boolean; rows: number; inserted: number; updated: number; error: string | null } | null; quoted: number; total: number }
export interface BondAllocationLine { code: string; name: string; issuer: string; issuerType: IssuerType; price: number; pricePct: number; accrued: number; quantity: number; amount: number; weightPct: number; couponPct: number; ytmPct: number; durationYears: number; remainingYears: number; maturityDate: string; annualCoupon: number; taxExempt: boolean; rationale: string }
export interface BondSleeve { targetSharePct: number; sharePct: number; amount: number; lines: BondAllocationLine[]; annualCoupons: number; avgYieldPct: number; avgDurationYears: number; rationale: string[] }
export interface BondLine {
  code: string; name: string; issuer: string; issuerType: string; quantity: number; avgPrice: number | null; price: number; pricePct: number; quoteSource: "brvm" | "admin" | "simulation"; accrued: number; value: number; cost: number | null; pnl: number | null; weightPct: number; couponPct: number; ytmPct: number; currentYieldPct: number; durationYears: number; remainingYears: number; maturityDate: string; outstanding: number; nextCoupon: { date: number; amount: number } | null; annualCoupon: number; taxExempt: boolean; perf1M: number | null;
  action: { kind: LineAction; quantity: number; amount: number; reasons: string[] };
}
export const ISSUER_LABEL: Record<IssuerType, string> = { souverain: "État", supranational: "Supranational", entreprise: "Entreprise" };
export const AMORT_LABEL: Record<string, string> = { in_fine: "In fine", constant: "Amortissement constant", annuite: "Annuités constantes" };

// ---- Documents des sociétés ----
export interface CompanyDocument { id: number; symbol: string; title: string; kind: string; period: string | null; url: string; published_at: number | null; source: string; summary: string | null; fetched_at: number }
export interface DocumentsResponse { items: CompanyDocument[]; status: { sources: { name: string; url: string; perCompany: boolean }[]; documents: number; companies: number; bySymbol: { symbol: string; n: number; last: number | null }[]; lastRun: { at: number; ok: string[]; failed: string[]; inserted: number } | null } }
export interface DocumentHistory { symbol: string; name: string; total: number; years: { year: string; documents: CompanyDocument[] }[]; kinds: Record<string, number>; latestResults: CompanyDocument | null; latestAnnualReport: CompanyDocument | null }

// ---- Score de qualité, profils d'émetteurs, radar ----
export type QualityBand = "SOLIDE" | "CORRECT" | "FRAGILE" | "RISQUÉ";
export interface QualityPart { key: string; label: string; points: number; max: number; verified: boolean; value: string; text: string }
export interface QualityResult { symbol: string; score: number; band: QualityBand; confidence: number; parts: QualityPart[]; flags: { hard: boolean; text: string }[]; unverified: string[]; headline: string; rulesVersion: string; computedAt: number }
export interface CompanyProfile { freeFloatPct: number | null; mainHolderPct: number | null; mainHolderName: string | null; statePct: number | null; sharesOutstanding: number | null; payoutRatioPct: number | null; dividendYears: number | null; suspended: boolean; suspendedReason: string | null; note: string | null; updatedAt: number | null }
export const QUALITY_BAND_CLASS: Record<QualityBand, string> = { SOLIDE: "strong-buy", CORRECT: "buy", FRAGILE: "reduce", "RISQUÉ": "sell" };
export type RadarKind = "introduction" | "emission_obligataire" | "offre_publique" | "dividende" | "resultats" | "assemblee" | "suspension" | "nouvelle_obligation" | "augmentation_capital" | "calendrier";
export const RADAR_KIND_LABEL: Record<RadarKind, string> = { introduction: "Introduction en bourse", emission_obligataire: "Émission obligataire", offre_publique: "Offre publique", dividende: "Dividende", resultats: "Résultats", assemblee: "Assemblée générale", suspension: "Suspension", nouvelle_obligation: "Nouvelle obligation cotée", augmentation_capital: "Augmentation de capital", calendrier: "Échéance à venir" };
export interface RadarEvent { id: number; kind: RadarKind; symbol: string | null; title: string; detail: string | null; url: string | null; source: string; date: number; created_at: number }
export interface RadarResponse { items: RadarEvent[]; status: { byKind: { kind: RadarKind; n: number }[]; recent48h: number; lastScan: { at: number; inserted: number } | null } }

// ---- Données officielles : actions sur le capital, dividendes, bulletin de la cote ----
export interface AdjustmentStep { exDate: number; kind: "split" | "reverse_split" | "dividend" | "bonus"; priceFactor: number; volumeFactor: number; detail: string }
export interface CorporateActionView { id: number; symbol: string; name: string; kind: "split" | "reverse_split" | "bonus"; exDate: number; ratio: number | null; status: "confirmé" | "suspecté"; source: string; note: string | null; updatedAt: number }
export type DividendStatus = "proposé" | "approuvé" | "payé";
export interface DividendView { id: number; symbol: string; name: string; fiscalYear: number; gross: number | null; net: number | null; netEstimated: number | null; exDate: number | null; paymentDate: number | null; agmDate: number | null; status: DividendStatus; source: string; url: string | null; note: string | null; updatedAt: number }
export interface DividendInfo { last: DividendView | null; yieldPct: number | null; next: { exDate: number; amount: number; fiscalYear: number; status: DividendStatus } | null; years: number }
export interface CorporateStatus { actions: number; suspected: number; dividends: number; symbolsWithDividends: number; version: number }
export interface CorporateSymbolResponse { symbol: string; actions: CorporateActionView[]; dividends: DividendView[]; info: DividendInfo; adjustments: AdjustmentStep[] }
export interface DailyStat { symbol: string; ts: number; ref: number | null; open: number | null; high: number | null; low: number | null; close: number | null; changePct: number | null; volume: number | null; value: number | null; trades: number | null; bid: number | null; bidQty: number | null; ask: number | null; askQty: number | null; imbalance: number | null; reserved: "up" | "down" | null; suspended: boolean; per: number | null; yieldPct: number | null; lastDividend: number | null; lastDividendDate: number | null; ytdPct: number | null; source: string; fetchedAt: number }
export interface CollectorsStatus {
  quotes: MarketStatus;
  history: { source: string; realCoverage: number; lastRun: { at: number; ok: number; failed: string[]; inserted: number; rescaled: number; removed: number; durationMs: number } | null; lastCapRun: { at: number; updated: number; failed: string[] } | null };
  bulletin: BocStatus;
  bonds: { lastRun: { at: number; ok: boolean; rows: number; inserted: number; updated: number; error: string | null } | null; quoted: number; total: number };
  news: { sources: string[]; items: number; lastRun: { at: number; ok: string[]; failed: string[] } | null; details: { name: string; url: string; ok: boolean | null; parsed: number; inserted: number; error: string | null; lastAt: number | null }[] };
  documents: { sources: { name: string; url: string; perCompany: boolean }[]; documents: number; companies: number; lastRun: { at: number; ok: string[]; failed: string[]; inserted: number } | null };
  dividends: CorporateStatus & { lastSikaRun: { at: number; history: number; upcoming: number } | null };
  fundamentals: { records: number; companies: number; auto: number; lastScan: { at: number; inserted: number; fetched: number; failed: number } | null };
  panel: { asOf: number | null; computedAt: number | null; symbols: number };
  policy: { brvm: string; sika: string; richbourse: string };
}
export interface HistoryStatus { source: string; suffixes: number; lastRun: CollectorsStatus["history"]["lastRun"]; lastCapRun: CollectorsStatus["history"]["lastCapRun"]; symbols: { symbol: string; candles: number; realSince: number | null; realCandles: number }[]; realCoverage: number }
export interface BocStatus { sources: string[]; columns: string[] | null; sessions: number; lastSession: number | null; symbolsLastSession: number; lastRun: { at: number; ok: boolean; session: number | null; rows: number; applied: number; source: string | null; error: string | null; bonds?: number; dividends?: number; notices?: number } | null; pdfSupport: boolean; auto: boolean }
export interface BocSymbolResponse { symbol: string; latest: DailyStat | null; activity: { sessions: number; avgTrades: number | null; reservedUp: number; reservedDown: number; suspendedDays: number; lastImbalance: number | null }; stats: DailyStat[] }
export const ACTION_KIND_LABEL: Record<string, string> = { split: "Fractionnement", reverse_split: "Regroupement", bonus: "Attribution gratuite", dividend: "Dividende" };

// ---- Évaluation en marche avant ----
export interface EvaluationConfig { sessions: number; step: number; topK: number; feePct: number; minHistory: number; horizons: Horizon[]; seed: number }
export interface ReliabilityBin { from: number; to: number; n: number; predicted: number | null; observed: number | null }
export interface StrategyStats { periods: number; totalReturnPct: number; annualizedPct: number | null; maxDrawdownPct: number; sharpe: number | null; winShare: number; curve: { ts: number; value: number }[] }
export interface HorizonEvaluation { horizon: Horizon; horizonDays: number; n: number; dates: number; hitRate: number; baselineHitRate: number; maePct: number; naiveMaePct: number; skill: number; ic: { mean: number | null; std: number | null; tStat: number | null; positiveShare: number | null; dates: number }; coverage90: number; brier: number; baselineBrier: number; reliability: ReliabilityBin[]; strategy: { topK: StrategyStats; index: StrategyStats | null; equalWeight: StrategyStats; costsPct: number } }
export interface EvaluationReport { generatedAt: number; config: EvaluationConfig; universe: number; firstDate: number | null; lastDate: number | null; horizons: HorizonEvaluation[]; verdict: string[] }
export interface EvaluationResponse { latest: { id: number; createdAt: number; report: EvaluationReport } | null; status: { running: { startedAt: number; done: number; total: number; config: EvaluationConfig } | null; latestAt: number | null; reports: number } }

// ---- Fondamentaux et modèle de panel ----
export interface FinancialRecord { id: number; symbol: string; period: string; periodEnd: number; publishedAt: number | null; revenue: number | null; netIncome: number | null; equity: number | null; shares: number | null; eps: number | null; dps: number | null; revenueGrowthPct: number | null; netIncomeGrowthPct: number | null; source: string; url: string | null; note: string | null; status: "auto" | "analyste"; updatedAt: number }
export interface ValuationMetrics { annualPeriod: string | null; latestPeriod: string | null; eps: number | null; bookValuePerShare: number | null; per: number | null; priceToBook: number | null; earningsYieldPct: number | null; roePct: number | null; revenueGrowthPct: number | null; netIncomeGrowthPct: number | null; payoutPct: number | null; netMarginPct: number | null; shares: number | null; missing: string[] }
export interface CompanyFundamentals { symbol: string; name: string; price: number; records: FinancialRecord[]; metrics: ValuationMetrics }
export interface FundamentalsResponse { items: CompanyFundamentals[]; status: { records: number; companies: number; auto: number; lastScan: { at: number; inserted: number; fetched: number; failed: number } | null } }
export interface PanelSummary { asOf: number | null; computedAt: number | null; symbols: number; stats: { horizon: Horizon; samples: number; testSamples: number; testMaePct: number | null; naiveMaePct: number | null; hitRate: number | null; lambda: number }[]; ranking: { symbol: string; name: string; relPct: number; top: string | null }[] }
