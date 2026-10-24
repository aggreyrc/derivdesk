import { describe, expect, it } from "vitest";
import {
  advanceRiskState,
  advanceStakingState,
  checkRiskLimits,
  INITIAL_RISK_STATE,
  INITIAL_STAKING_STATE,
  isLadderExhausted,
  nextStake,
} from "../staking.js";
import type { RiskLimits, StakingConfig } from "../strategy.schema.js";

const fixedConfig: StakingConfig = { mode: "FIXED", stake: 2 };
const martingale: StakingConfig = { mode: "MARTINGALE", baseStake: 1, multiplierOnLoss: 2, maxSteps: 4, resetOnWin: true };

describe("nextStake", () => {
  it("is constant under FIXED staking regardless of state", () => {
    expect(nextStake(fixedConfig, { currentStep: 0 })).toBe(2);
    expect(nextStake(fixedConfig, { currentStep: 3 })).toBe(2);
  });

  it("doubles per step under MARTINGALE, capped at maxSteps - 1", () => {
    expect(nextStake(martingale, { currentStep: 0 })).toBe(1);
    expect(nextStake(martingale, { currentStep: 1 })).toBe(2);
    expect(nextStake(martingale, { currentStep: 2 })).toBe(4);
    expect(nextStake(martingale, { currentStep: 3 })).toBe(8);
    // currentStep 5 would be past maxSteps(4)'s ladder — caps at the step-3 stake rather than
    // climbing further; checkRiskLimits is what actually stops the bot before this happens.
    expect(nextStake(martingale, { currentStep: 10 })).toBe(8);
  });

  it("never hands Deriv a stake with floating-point noise", () => {
    const odd: StakingConfig = { mode: "MARTINGALE", baseStake: 0.1, multiplierOnLoss: 2, maxSteps: 8, resetOnWin: true };
    const stake = nextStake(odd, { currentStep: 7 });
    expect(stake).toBe(Math.round(stake * 100) / 100);
  });
});

describe("advanceStakingState", () => {
  it("resets to step 0 on a win when resetOnWin is true", () => {
    expect(advanceStakingState(martingale, { currentStep: 3 }, true)).toEqual({ currentStep: 0 });
  });

  it("holds the step on a win when resetOnWin is false", () => {
    const noReset: StakingConfig = { ...martingale, resetOnWin: false };
    expect(advanceStakingState(noReset, { currentStep: 2 }, true)).toEqual({ currentStep: 2 });
  });

  it("climbs one step on a loss, capped at maxSteps", () => {
    expect(advanceStakingState(martingale, { currentStep: 3 }, false)).toEqual({ currentStep: 4 });
    expect(advanceStakingState(martingale, { currentStep: 4 }, false)).toEqual({ currentStep: 4 });
  });

  it("never changes state under FIXED staking", () => {
    expect(advanceStakingState(fixedConfig, INITIAL_STAKING_STATE, false)).toBe(INITIAL_STAKING_STATE);
  });
});

describe("isLadderExhausted", () => {
  it("is true once the martingale ladder has climbed to maxSteps", () => {
    expect(isLadderExhausted(martingale, { currentStep: 4 })).toBe(true);
    expect(isLadderExhausted(martingale, { currentStep: 3 })).toBe(false);
  });

  it("is never true for FIXED staking", () => {
    expect(isLadderExhausted(fixedConfig, { currentStep: 999 })).toBe(false);
  });
});

describe("checkRiskLimits", () => {
  const limits: RiskLimits = { stopLossAmount: 20, targetProfitAmount: 20, maxConsecutiveLosses: 3, maxTradesPerSession: 10 };

  it("returns null when nothing has been breached", () => {
    expect(checkRiskLimits(limits, martingale, INITIAL_STAKING_STATE, INITIAL_RISK_STATE)).toBeNull();
  });

  it("fires STOP_LOSS_REACHED once session P/L drops to or past -stopLossAmount", () => {
    const risk = { sessionProfitLoss: -20, consecutiveLosses: 1, tradesCount: 2 };
    expect(checkRiskLimits(limits, martingale, INITIAL_STAKING_STATE, risk)).toBe("STOP_LOSS_REACHED");
  });

  it("fires TARGET_PROFIT_REACHED once session P/L reaches targetProfitAmount", () => {
    const risk = { sessionProfitLoss: 25, consecutiveLosses: 0, tradesCount: 5 };
    expect(checkRiskLimits(limits, martingale, INITIAL_STAKING_STATE, risk)).toBe("TARGET_PROFIT_REACHED");
  });

  it("fires MAX_CONSECUTIVE_LOSSES before either P/L limit if the streak hits first", () => {
    const risk = { sessionProfitLoss: -5, consecutiveLosses: 3, tradesCount: 3 };
    expect(checkRiskLimits(limits, martingale, INITIAL_STAKING_STATE, risk)).toBe("MAX_CONSECUTIVE_LOSSES");
  });

  it("fires MAX_TRADES_PER_SESSION once the session trade count caps out", () => {
    const risk = { sessionProfitLoss: 0, consecutiveLosses: 0, tradesCount: 10 };
    expect(checkRiskLimits(limits, martingale, INITIAL_STAKING_STATE, risk)).toBe("MAX_TRADES_PER_SESSION");
  });

  it("fires STAKE_LADDER_EXHAUSTED once the martingale ladder itself is exhausted", () => {
    expect(checkRiskLimits({}, martingale, { currentStep: 4 }, INITIAL_RISK_STATE)).toBe("STAKE_LADDER_EXHAUSTED");
  });
});

describe("advanceRiskState", () => {
  it("accumulates P/L and resets the loss streak on any winning trade", () => {
    const afterLoss = advanceRiskState(INITIAL_RISK_STATE, -5);
    expect(afterLoss).toEqual({ sessionProfitLoss: -5, consecutiveLosses: 1, tradesCount: 1 });

    const afterWin = advanceRiskState(afterLoss, 10);
    expect(afterWin).toEqual({ sessionProfitLoss: 5, consecutiveLosses: 0, tradesCount: 2 });
  });
});
