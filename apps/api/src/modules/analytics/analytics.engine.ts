// Pure performance maths over CLOSED trades. No Deriv calls, no DB, no clock — so every figure
// here is exhaustively unit-testable and there is exactly one definition of each metric.
//
// Source of truth: Deriv's own `profit_table` rows. The only number this app derives is each
// trade's profit/loss = sell_price - buy_price (plain subtraction of two figures Deriv reported).
// Nothing here is estimated, projected, or back-filled: a row Deriv gave us without a usable
// buy/sell price is EXCLUDED and counted (see `excluded`), never guessed at.

import type { ProfitTableEntry } from "../trading/trading.schemas.js";

export type TradeSource = "MANUAL" | "BOT";

export interface ClosedTrade {
  contractId: number;
  purchaseTime: number; // epoch seconds
  sellTime: number; // epoch seconds
  buyPrice: number;
  sellPrice: number;
  pnl: number;
  symbol: string | null;
  contractType: string | null;
  source: TradeSource;
}

/** Kills float noise (0.1 + 0.2) without hiding real precision: 8 dp covers every currency
 *  Deriv supports, crypto included. */
export const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;

const toNumber = (v: number | string | undefined | null): number | null => {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export function normalizeRows(entries: ProfitTableEntry[], botContractIds: ReadonlySet<string>): { trades: ClosedTrade[]; excluded: number } {
  const trades: ClosedTrade[] = [];
  let excluded = 0;
  for (const e of entries) {
    const buy = toNumber(e.buy_price);
    const sell = toNumber(e.sell_price);
    if (e.contract_id === null || buy === null || sell === null || e.sell_time === null || e.sell_time === undefined) {
      excluded += 1;
      continue;
    }
    trades.push({
      contractId: e.contract_id,
      purchaseTime: e.purchase_time,
      sellTime: e.sell_time,
      buyPrice: buy,
      sellPrice: sell,
      pnl: round8(sell - buy),
      symbol: e.underlying_symbol ?? null,
      contractType: e.contract_type ?? null,
      source: botContractIds.has(String(e.contract_id)) ? "BOT" : "MANUAL",
    });
  }
  return { trades, excluded };
}

/** Chronological by settlement (the order the account's balance actually moved in). */
const chronological = (trades: ClosedTrade[]): ClosedTrade[] => [...trades].sort((a, b) => a.sellTime - b.sellTime || a.purchaseTime - b.purchaseTime);

export interface Summary {
  tradesCount: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** wins / tradesCount, 0..1. Null when there are no trades. Breakeven trades count in the denominator. */
  winRate: number | null;
  netPnl: number;
  grossProfit: number;
  grossLoss: number; // positive number
  /** grossProfit / grossLoss. Null when there were no losing trades (undefined, not infinity). */
  profitFactor: number | null;
  averageWin: number | null;
  averageLoss: number | null; // positive number
  /** Average profit/loss per trade. */
  expectancy: number | null;
  largestWin: number | null;
  largestLoss: number | null; // positive number
  totalStaked: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  /** Largest peak-to-trough fall in cumulative P/L (starting from 0), as a positive amount. */
  maxDrawdown: number;
}

export function computeSummary(trades: ClosedTrade[]): Summary {
  const ordered = chronological(trades);
  let wins = 0,
    losses = 0,
    breakeven = 0,
    grossProfit = 0,
    grossLoss = 0,
    staked = 0,
    streakW = 0,
    streakL = 0,
    maxW = 0,
    maxL = 0,
    cumulative = 0,
    peak = 0,
    maxDd = 0;
  let largestWin: number | null = null;
  let largestLoss: number | null = null;

  for (const t of ordered) {
    staked += t.buyPrice;
    cumulative += t.pnl;
    peak = Math.max(peak, cumulative);
    maxDd = Math.max(maxDd, peak - cumulative);

    if (t.pnl > 0) {
      wins += 1;
      grossProfit += t.pnl;
      streakW += 1;
      streakL = 0;
      largestWin = largestWin === null ? t.pnl : Math.max(largestWin, t.pnl);
    } else if (t.pnl < 0) {
      losses += 1;
      grossLoss += -t.pnl;
      streakL += 1;
      streakW = 0;
      largestLoss = largestLoss === null ? -t.pnl : Math.max(largestLoss, -t.pnl);
    } else {
      breakeven += 1;
      streakW = 0;
      streakL = 0;
    }
    maxW = Math.max(maxW, streakW);
    maxL = Math.max(maxL, streakL);
  }

  const n = ordered.length;
  const net = grossProfit - grossLoss;
  return {
    tradesCount: n,
    wins,
    losses,
    breakeven,
    winRate: n === 0 ? null : wins / n,
    netPnl: round8(net),
    grossProfit: round8(grossProfit),
    grossLoss: round8(grossLoss),
    profitFactor: grossLoss === 0 ? null : round8(grossProfit / grossLoss),
    averageWin: wins === 0 ? null : round8(grossProfit / wins),
    averageLoss: losses === 0 ? null : round8(grossLoss / losses),
    expectancy: n === 0 ? null : round8(net / n),
    largestWin: largestWin === null ? null : round8(largestWin),
    largestLoss: largestLoss === null ? null : round8(largestLoss),
    totalStaked: round8(staked),
    maxConsecutiveWins: maxW,
    maxConsecutiveLosses: maxL,
    maxDrawdown: round8(maxDd),
  };
}

export interface SeriesPoint {
  time: number; // epoch seconds (sell time)
  pnl: number;
  cumulative: number;
}

export interface BreakdownRow {
  key: string;
  tradesCount: number;
  wins: number;
  netPnl: number;
  winRate: number | null;
}

function breakdown(trades: ClosedTrade[], keyOf: (t: ClosedTrade) => string): BreakdownRow[] {
  const groups = new Map<string, { n: number; wins: number; net: number }>();
  for (const t of trades) {
    const k = keyOf(t);
    const g = groups.get(k) ?? { n: 0, wins: 0, net: 0 };
    g.n += 1;
    if (t.pnl > 0) g.wins += 1;
    g.net += t.pnl;
    groups.set(k, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, tradesCount: g.n, wins: g.wins, netPnl: round8(g.net), winRate: g.n === 0 ? null : g.wins / g.n }))
    .sort((a, b) => b.tradesCount - a.tradesCount || a.key.localeCompare(b.key));
}

export interface Performance {
  series: SeriesPoint[];
  /** UTC calendar days — a day boundary is midnight UTC, not the viewer's local time. */
  byDay: BreakdownRow[];
  bySymbol: BreakdownRow[];
  byContractType: BreakdownRow[];
  bySource: BreakdownRow[];
}

export function computePerformance(trades: ClosedTrade[]): Performance {
  const ordered = chronological(trades);
  let cumulative = 0;
  const series = ordered.map((t) => {
    cumulative += t.pnl;
    return { time: t.sellTime, pnl: t.pnl, cumulative: round8(cumulative) };
  });
  const day = (t: ClosedTrade) => new Date(t.sellTime * 1000).toISOString().slice(0, 10);
  return {
    series,
    byDay: breakdown(ordered, day).sort((a, b) => a.key.localeCompare(b.key)),
    // Symbol/contract type only exist when Deriv was asked for descriptions; a row without
    // them is grouped as "Unknown" rather than dropped or guessed.
    bySymbol: breakdown(ordered, (t) => t.symbol ?? "Unknown"),
    byContractType: breakdown(ordered, (t) => t.contractType ?? "Unknown"),
    bySource: breakdown(ordered, (t) => (t.source === "BOT" ? "Bot" : "Manual")),
  };
}
