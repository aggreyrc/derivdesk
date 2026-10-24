import type { DerivAccount, PrismaClient } from "@derivdesk/db";
import type { TradingSessionManager } from "../trading/trading.sessionManager.js";
import { computePerformance, computeSummary, normalizeRows, type ClosedTrade } from "./analytics.engine.js";

export type Period = "7d" | "30d" | "90d" | "all";
const PERIOD_DAYS: Record<Exclude<Period, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };

const PAGE_SIZE = 500; // Deriv's documented maximum per profit_table call
export const MAX_TRADES = 2000; // 4 calls — bounded so one request can't burn the profit_table rate limit
const CACHE_TTL_MS = 60_000;

/** Display precision: fiat and USD-pegged stablecoins show 2 decimals, everything else (BTC,
 *  ETH, …) 8 — so a 0.00012 BTC result doesn't render as 0.00. */
const TWO_DECIMAL_CURRENCIES = new Set(["USD", "EUR", "GBP", "AUD", "USDT", "USDC", "UST", "EUSDT", "TUSDT"]);
export const displayDecimals = (currency: string): number => (TWO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 2 : 8);

export interface AnalyticsDeps {
  db: PrismaClient;
  trading: Pick<TradingSessionManager, "getProfitTable">;
  now?: () => number;
}

export interface AnalyticsMeta {
  period: Period;
  accountType: "REAL" | "DEMO";
  derivAccountId: string;
  currency: string;
  decimals: number;
  tradesAnalyzed: number;
  /** Rows Deriv returned that had no usable buy/sell price or settle time. */
  excludedRows: number;
  /** True when the period may hold more than MAX_TRADES trades; only the most recent MAX_TRADES are analysed. */
  truncated: boolean;
  generatedAt: string;
}

interface Loaded {
  trades: ClosedTrade[];
  excluded: number;
  truncated: boolean;
  generatedAt: number;
}

const cache = new Map<string, Loaded>();
export const clearAnalyticsCache = () => cache.clear();

async function botContractIds(db: PrismaClient, userId: string, accountRowId: string): Promise<Set<string>> {
  const instances = await db.botInstance.findMany({ where: { userId, derivAccountId: accountRowId } });
  if (instances.length === 0) return new Set();
  const trades = await db.botTrade.findMany({ where: { botInstanceId: { in: instances.map((i) => i.id) } } });
  return new Set(trades.map((t) => t.contractId));
}

async function load(deps: AnalyticsDeps, userId: string, account: DerivAccount, period: Period): Promise<Loaded> {
  const now = (deps.now ?? Date.now)();
  const key = `${userId}:${account.id}:${period}`;
  const hit = cache.get(key);
  if (hit && now - hit.generatedAt < CACHE_TTL_MS) return hit;

  const nowSec = Math.floor(now / 1000);
  const dateFrom = period === "all" ? undefined : nowSec - PERIOD_DAYS[period] * 86_400;
  const entries = [];
  let truncated = false;

  // date_to is pinned to "now" so trades placed while we page can't shift the offsets.
  for (let offset = 0; offset < MAX_TRADES; offset += PAGE_SIZE) {
    const page = await deps.trading.getProfitTable(userId, account.derivAccountId, Math.min(PAGE_SIZE, MAX_TRADES - offset), {
      offset,
      sort: "DESC",
      dateFrom,
      dateTo: nowSec,
      description: true,
    });
    entries.push(...page);
    if (page.length < PAGE_SIZE) break;
    if (offset + PAGE_SIZE >= MAX_TRADES) truncated = true; // a full final page: there may be older trades we didn't read
  }

  const { trades, excluded } = normalizeRows(entries, await botContractIds(deps.db, userId, account.id));
  const loaded = { trades, excluded, truncated, generatedAt: now };
  cache.set(key, loaded);
  return loaded;
}

function metaOf(account: DerivAccount, period: Period, l: Loaded): AnalyticsMeta {
  return {
    period,
    accountType: account.accountType as "REAL" | "DEMO",
    derivAccountId: account.derivAccountId,
    currency: account.currency,
    decimals: displayDecimals(account.currency),
    tradesAnalyzed: l.trades.length,
    excludedRows: l.excluded,
    truncated: l.truncated,
    generatedAt: new Date(l.generatedAt).toISOString(),
  };
}

export async function getSummary(deps: AnalyticsDeps, userId: string, account: DerivAccount, period: Period) {
  const l = await load(deps, userId, account, period);
  return { meta: metaOf(account, period, l), summary: computeSummary(l.trades) };
}

export async function getPerformance(deps: AnalyticsDeps, userId: string, account: DerivAccount, period: Period) {
  const l = await load(deps, userId, account, period);
  return { meta: metaOf(account, period, l), ...computePerformance(l.trades) };
}
