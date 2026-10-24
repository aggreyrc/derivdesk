// Shapes returned by /api/analytics/* (see apps/api/src/modules/analytics). Every money figure
// is derived server-side from Deriv's own closed-trade records; nothing here is estimated.

export type AnalyticsPeriod = "7d" | "30d" | "90d" | "all";

export interface AnalyticsMeta {
  period: AnalyticsPeriod;
  accountType: "REAL" | "DEMO";
  derivAccountId: string;
  currency: string;
  decimals: number;
  tradesAnalyzed: number;
  excludedRows: number;
  truncated: boolean;
  generatedAt: string;
}

export interface Summary {
  tradesCount: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  expectancy: number | null;
  largestWin: number | null;
  largestLoss: number | null;
  totalStaked: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  maxDrawdown: number;
}

export interface BreakdownRow {
  key: string;
  tradesCount: number;
  wins: number;
  netPnl: number;
  winRate: number | null;
}

export interface PerformanceData {
  meta: AnalyticsMeta;
  series: Array<{ time: number; pnl: number; cumulative: number }>;
  byDay: BreakdownRow[];
  bySymbol: BreakdownRow[];
  byContractType: BreakdownRow[];
  bySource: BreakdownRow[];
}

export interface TechnicalData {
  symbol: string;
  granularity: number;
  params: { sma: number; emaFast: number; emaSlow: number; rsi: number; macd: { fast: number; slow: number; signal: number } };
  candles: Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
  series: {
    sma20: (number | null)[];
    ema20: (number | null)[];
    ema50: (number | null)[];
    rsi14: (number | null)[];
    macd: { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] };
  };
  readings: {
    lastClose: number | null;
    lastCandleEpoch: number | null;
    priceVsEma20: "above" | "below" | "equal" | null;
    priceVsEma50: "above" | "below" | "equal" | null;
    ema20VsEma50: "above" | "below" | "equal" | null;
    rsi: { value: number; zone: "above70" | "below30" | "between30and70" } | null;
    macd: { histogram: number; sign: "positive" | "negative" | "zero"; changedSignOnLastCandle: boolean } | null;
  };
}
