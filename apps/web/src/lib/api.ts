import { API_BASE_URL } from "./apiBase";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include", // send/receive the httpOnly session cookie
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? "UnknownError", body?.error?.message ?? "Request failed");
  }

  return body?.data as T;
}

import type {
  BuyResult,
  ContractFor,
  ContractType,
  DerivConnectionState,
  PaymentAgentView,
  PaymentAgentWithdrawalSummary,
  PortfolioContract,
  ProfitTableEntry,
  Proposal,
  SellResult,
  WithdrawalOtpResult,
} from "@derivdesk/shared-types";
import type { ActiveSymbol, Candle } from "./marketTypes";
import type { AnalyticsMeta, AnalyticsPeriod, PerformanceData, Summary, TechnicalData } from "./analyticsTypes";
import type { BotCatalogEntry, BotRiskParams, BotTradeView, BotView, CreateBotInput } from "./botTypes";

export interface CurrentUser {
  id: string;
  /** The user's Deriv account id. Users sign in with Deriv only: there is no email or password. */
  handle: string;
}

export const api = {
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  me: () => request<CurrentUser>("/api/auth/me"),

  derivConnect: () => request<{ url: string }>("/api/deriv/connect"),
  derivAccounts: () => request<DerivConnectionState>("/api/deriv/accounts"),
  derivRefresh: () => request<DerivConnectionState>("/api/deriv/accounts/refresh", { method: "POST" }),
  derivActivate: (accountId: string, confirmReal: boolean) =>
    request<DerivConnectionState>(`/api/deriv/accounts/${accountId}/activate`, { method: "POST", body: JSON.stringify({ confirmReal }) }),
  derivDisconnect: () => request<void>("/api/deriv/connection", { method: "DELETE" }),

  marketSymbols: () => request<ActiveSymbol[]>("/api/markets/symbols"),
  marketCandles: (symbol: string, granularity: number, count: number) =>
    request<{ candles: Candle[]; pipSize: number | null }>(`/api/markets/candles?symbol=${encodeURIComponent(symbol)}&granularity=${granularity}&count=${count}`),
  watchlist: () => request<string[]>("/api/markets/watchlist"),
  watchlistAdd: (symbol: string) => request<string[]>("/api/markets/watchlist", { method: "POST", body: JSON.stringify({ symbol }) }),
  watchlistRemove: (symbol: string) => request<string[]>(`/api/markets/watchlist/${encodeURIComponent(symbol)}`, { method: "DELETE" }),

  // Which contract types/parameters Deriv actually supports for a symbol — the trade
  // ticket builds its form from this, never from a hardcoded list.
  contractsFor: (symbol: string) => request<ContractFor[]>(`/api/markets/contracts-for?symbol=${encodeURIComponent(symbol)}`),

  proposal: (body: {
    contractType: ContractType;
    symbol: string;
    amount?: number;
    basis?: "payout" | "stake";
    duration?: number;
    durationUnit?: "d" | "m" | "s" | "h" | "t";
    barrier?: string;
    barrier2?: string;
    multiplier?: number;
  }) => request<Proposal>("/api/trading/proposal", { method: "POST", body: JSON.stringify(body) }),

  buy: (body: { proposalId: string; priceAgreed: number; contractType: ContractType; underlyingSymbol: string; confirmReal?: boolean }) =>
    request<BuyResult>("/api/trading/buy", { method: "POST", body: JSON.stringify(body) }),

  sell: (contractId: number, minPrice = 0) =>
    request<SellResult>("/api/trading/sell", { method: "POST", body: JSON.stringify({ contractId, minPrice }) }),

  portfolio: () => request<PortfolioContract[]>("/api/trading/portfolio"),

  tradeHistory: (limit = 50) => request<ProfitTableEntry[]>(`/api/trading/history?limit=${limit}`),

  // Payments (Phase 6) — withdrawals only, and only on the active REAL account; the server
  // enforces that gate independently, this is just what the UI builds requests against.
  depositLink: () => request<{ url: string }>("/api/payments/deposit-link"),
  paymentAgents: (country?: string) =>
    request<PaymentAgentView[]>(`/api/payments/agents${country ? `?country=${encodeURIComponent(country)}` : ""}`),
  requestWithdrawalOtp: (agentId: number, amount: number) =>
    request<WithdrawalOtpResult>("/api/payments/withdraw/verification-code", { method: "POST", body: JSON.stringify({ agentId, amount }) }),
  withdraw: (body: { agentId: number; amount: number; verificationCode: string; notes?: string }) =>
    request<PaymentAgentWithdrawalSummary>("/api/payments/withdraw", { method: "POST", body: JSON.stringify(body) }),
  withdrawalStatus: (requestId: string) => request<PaymentAgentWithdrawalSummary>(`/api/payments/withdraw/${encodeURIComponent(requestId)}`),
  withdrawalHistory: () => request<PaymentAgentWithdrawalSummary[]>("/api/payments/history"),

  // Bots — server-side, always-on. Every call is scoped to the signed-in user; the account a
  // bot trades on is chosen at creation and can never be changed afterwards.
  botCatalog: () => request<BotCatalogEntry[]>("/api/bots/strategies"),
  bots: () => request<BotView[]>("/api/bots"),
  createBot: (body: CreateBotInput) => request<BotView>("/api/bots", { method: "POST", body: JSON.stringify(body) }),
  updateBot: (id: string, body: { name?: string; symbol?: string; riskParams?: BotRiskParams }) =>
    request<BotView>(`/api/bots/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  startBot: (id: string, confirmReal: boolean) => request<BotView>(`/api/bots/${encodeURIComponent(id)}/start`, { method: "POST", body: JSON.stringify({ confirmReal }) }),
  pauseBot: (id: string) => request<BotView>(`/api/bots/${encodeURIComponent(id)}/pause`, { method: "POST" }),
  stopBot: (id: string) => request<BotView>(`/api/bots/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  deleteBot: (id: string) => request<void>(`/api/bots/${encodeURIComponent(id)}`, { method: "DELETE" }),
  botTrades: (id: string, limit = 20) => request<BotTradeView[]>(`/api/bots/${encodeURIComponent(id)}/trades?limit=${limit}`),

  // Analytics (Phase 7) — performance is for the ACTIVE account and says whether it's demo or
  // real in `meta`; technical analysis is market data and needs no account.
  analyticsSummary: (period: AnalyticsPeriod) => request<{ meta: AnalyticsMeta; summary: Summary }>(`/api/analytics/summary?period=${period}`),
  analyticsPerformance: (period: AnalyticsPeriod) => request<PerformanceData>(`/api/analytics/performance?period=${period}`),
  analyticsTechnical: (symbol: string, granularity: number, count = 300) =>
    request<TechnicalData>(`/api/analytics/technical?symbol=${encodeURIComponent(symbol)}&granularity=${granularity}&count=${count}`),
};
