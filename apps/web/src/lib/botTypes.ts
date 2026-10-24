// Shapes returned by /api/bots/* (see apps/api/src/modules/bots/bots.service.ts). Decimals
// arrive as strings over JSON; JSON columns (riskParams, stakingState, riskState) are typed
// to what the server's own Zod schemas guarantee.

export type BotStaking =
  | { mode: "FIXED"; stake: number }
  | { mode: "MARTINGALE"; baseStake: number; multiplierOnLoss: number; maxSteps: number; resetOnWin: boolean };

export interface BotRiskLimits {
  stopLossAmount?: number;
  targetProfitAmount?: number;
  maxConsecutiveLosses?: number;
  maxTradesPerSession?: number;
}

export interface BotRiskParams {
  staking: BotStaking;
  riskLimits: BotRiskLimits;
}

export interface BotCatalogEntry {
  id: string;
  key: string;
  name: string;
  description: string;
  candleGranularitySeconds: number;
  indicators: string[];
  contractTypes: string[];
  tradeParams: { durationValue: number; durationUnit: string };
  suggested: BotRiskParams;
}

export type BotStatus = "DRAFT" | "RUNNING" | "PAUSED" | "STOPPED" | "ERROR";

export interface BotView {
  id: string;
  name: string;
  symbol: string;
  status: BotStatus;
  stopReason: string | null;
  lastError: string | null;
  lastEvaluatedAt: string | null;
  startedAt: string | null;
  riskParams: BotRiskParams;
  stakingState: { currentStep: number };
  riskState: { sessionProfitLoss: number; consecutiveLosses: number; tradesCount: number };
  strategy: { id: string; name: string };
  derivAccount: { id: string; derivAccountId: string; accountType: "REAL" | "DEMO"; currency: string };
}

export interface BotTradeView {
  id: string;
  contractId: string;
  contractType: string;
  stake: string;
  stakeStep: number;
  profit: string | null;
  status: "OPEN" | "CLOSED" | "SOLD" | "CANCELLED";
  placedAt: string;
}

export interface CreateBotInput {
  strategyId: string;
  accountId: string;
  name: string;
  symbol: string;
  riskParams: BotRiskParams;
  confirmReal: boolean;
}
