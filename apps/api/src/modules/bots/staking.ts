// Stake-progression ladder and risk-limit checks — the other half of a strategy's behavior
// beyond entry signals (signalEngine.ts). Pure functions over an explicit state object; the
// bot runner (Phase 6 bots work) persists that state on BotInstance between evaluations so it
// survives a process restart, per the "server-side, always-on" requirement.

import type { RiskLimits, StakingConfig } from "./strategy.schema.js";

export interface StakingState {
  /** 0-based position in the ladder. 0 = base stake, regardless of staking mode. */
  currentStep: number;
}

export const INITIAL_STAKING_STATE: StakingState = { currentStep: 0 };

/** The stake to use for the NEXT trade, given the current ladder position. */
export function nextStake(config: StakingConfig, state: StakingState): number {
  if (config.mode === "FIXED") return config.stake;
  const step = Math.min(state.currentStep, config.maxSteps - 1);
  // Round to 2dp — every Deriv account currency this app supports is 2-decimal; a raw
  // floating-point multiplier chain (0.1 * 2^7, etc.) would otherwise hand Deriv a stake like
  // 12.800000000000002 and risk an InvalidStake rejection on the actual buy.
  return Math.round(config.baseStake * Math.pow(config.multiplierOnLoss, step) * 100) / 100;
}

/** Advances the ladder after a trade settles. Win resets it (if the strategy says to); loss
 *  climbs it by one step, capped at maxSteps so the stake itself never grows past the ladder's
 *  own ceiling (the separate maxSteps risk check below is what actually stops the bot). */
export function advanceStakingState(config: StakingConfig, state: StakingState, won: boolean): StakingState {
  if (config.mode === "FIXED") return state;
  if (won) return config.resetOnWin ? { currentStep: 0 } : state;
  return { currentStep: Math.min(state.currentStep + 1, config.maxSteps) };
}

export function isLadderExhausted(config: StakingConfig, state: StakingState): boolean {
  return config.mode === "MARTINGALE" && state.currentStep >= config.maxSteps;
}

export interface RiskState {
  /** Realized profit/loss (positive = profit) since the instance's session was last reset. */
  sessionProfitLoss: number;
  consecutiveLosses: number;
  tradesCount: number;
}

export const INITIAL_RISK_STATE: RiskState = { sessionProfitLoss: 0, consecutiveLosses: 0, tradesCount: 0 };

export type StopReason =
  | "TARGET_PROFIT_REACHED"
  | "STOP_LOSS_REACHED"
  | "MAX_CONSECUTIVE_LOSSES"
  | "MAX_TRADES_PER_SESSION"
  | "STAKE_LADDER_EXHAUSTED";

/** Checked BEFORE every trade the runner would otherwise place. A non-null result means the
 *  instance must stop (and be marked with that reason) rather than trade again — this is the
 *  kill switch the user configures per instance (stop-loss / target-profit / etc.), independent
 *  of Deriv's own account balance. */
export function checkRiskLimits(limits: RiskLimits, staking: StakingConfig, stakingState: StakingState, riskState: RiskState): StopReason | null {
  if (limits.targetProfitAmount !== undefined && riskState.sessionProfitLoss >= limits.targetProfitAmount) {
    return "TARGET_PROFIT_REACHED";
  }
  if (limits.stopLossAmount !== undefined && riskState.sessionProfitLoss <= -limits.stopLossAmount) {
    return "STOP_LOSS_REACHED";
  }
  if (limits.maxConsecutiveLosses !== undefined && riskState.consecutiveLosses >= limits.maxConsecutiveLosses) {
    return "MAX_CONSECUTIVE_LOSSES";
  }
  if (limits.maxTradesPerSession !== undefined && riskState.tradesCount >= limits.maxTradesPerSession) {
    return "MAX_TRADES_PER_SESSION";
  }
  if (isLadderExhausted(staking, stakingState)) return "STAKE_LADDER_EXHAUSTED";
  return null;
}

/** Folds one settled trade's outcome into the running risk state. */
export function advanceRiskState(state: RiskState, profit: number): RiskState {
  return {
    sessionProfitLoss: state.sessionProfitLoss + profit,
    consecutiveLosses: profit < 0 ? state.consecutiveLosses + 1 : 0,
    tradesCount: state.tradesCount + 1,
  };
}
