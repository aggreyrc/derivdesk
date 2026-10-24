// The user-owned half of a bot instance's configuration (BotInstance.riskParams). Same shapes
// as StrategyDefinition.staking / .riskLimits, but these are the INSTANCE's own values — the
// admin template's staking/riskLimits are only a suggested starting point shown to the user,
// never applied to real money unless the user chose them for their own instance.
//
// A bot with no stop-loss and no target-profit is refused outright: unattended, always-on
// trading with no kill switch is not something this app will start for anyone.

import { z } from "zod";
import { riskLimitsSchema, stakingConfigSchema } from "./strategy.schema.js";

// Hard ceilings enforced server-side regardless of what the strategy or the client asks for.
export const MAX_STAKE_PER_TRADE = 1000;

export const botRiskParamsSchema = z
  .object({
    staking: stakingConfigSchema,
    riskLimits: riskLimitsSchema,
  })
  .superRefine((value, ctx) => {
    const { stopLossAmount, targetProfitAmount } = value.riskLimits;
    if (stopLossAmount === undefined && targetProfitAmount === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["riskLimits"], message: "Set a stop-loss or a target profit — a bot can't run without a kill switch" });
    }
    const peak =
      value.staking.mode === "FIXED"
        ? value.staking.stake
        : value.staking.baseStake * Math.pow(value.staking.multiplierOnLoss, value.staking.maxSteps - 1);
    if (peak > MAX_STAKE_PER_TRADE) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["staking"], message: `The largest stake this setup can reach (${peak.toFixed(2)}) exceeds the ${MAX_STAKE_PER_TRADE} per-trade ceiling` });
    }
  });
export type BotRiskParams = z.infer<typeof botRiskParamsSchema>;

export const stakingStateSchema = z.object({ currentStep: z.number().int().min(0) });
export const riskStateSchema = z.object({
  sessionProfitLoss: z.number(),
  consecutiveLosses: z.number().int().min(0),
  tradesCount: z.number().int().min(0),
});
