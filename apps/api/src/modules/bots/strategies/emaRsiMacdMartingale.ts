// The first built-in strategy — an EMA-trend + RSI-momentum + MACD-confirmation entry with a
// martingale (double-on-loss) stake ladder, matching the shape of the Deriv DBot strategy
// originally uploaded (EMA/RSI/MACD indicator blocks feeding a trade/before_purchase decision,
// with a martingale staking ladder and stop-loss/target-profit kill switches).
//
// IMPORTANT — read before trusting these exact numbers: the original uploaded DBot Blockly XML
// is no longer available in this session (an earlier environment reset appears to have dropped
// it; the only file currently in the uploads folder is the original 36-section project spec,
// not the bot export). Rather than guess at the exact EMA/RSI periods, MACD settings, stake
// multiplier, or stop-loss/target-profit amounts the original file encoded — which would
// violate this project's own "never guess, document the limitation" rule for something that
// risks real money — this definition uses conventional, clearly-labeled default parameters that
// implement the SAME strategy shape (EMA trend filter + RSI momentum + MACD confirmation,
// martingale-on-loss staking, hard stop-loss/target-profit). It is seeded here as a starting
// catalog entry an admin can review and tune from the admin strategy-catalog UI (Phase 6 bots,
// Task 4) — or you can re-upload the original DBot XML so the exact thresholds can be matched.
//
// This file is intentionally just DATA (a StrategyDefinition) plus the catalog metadata the
// admin seed/CRUD uses to create the BotStrategy row — no trading logic lives here; the engine
// that interprets it is signalEngine.ts + staking.ts, shared by every strategy in the catalog.

import type { StrategyDefinition } from "../strategy.schema.js";

export const EMA_RSI_MACD_MARTINGALE_KEY = "ema-rsi-macd-martingale";

export const emaRsiMacdMartingaleDefinition: StrategyDefinition = {
  candleGranularitySeconds: 60,
  indicators: [
    { id: "ema_fast", type: "EMA", period: 10 },
    { id: "ema_slow", type: "EMA", period: 25 },
    { id: "rsi_14", type: "RSI", period: 14 },
    { id: "macd_main", type: "MACD", fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  ],
  entryRules: [
    {
      // Uptrend (fast EMA above slow EMA) + momentum not already overbought + MACD histogram
      // confirming bullish momentum.
      contractType: "CALL",
      when: {
        all: [
          { left: { kind: "indicator", id: "ema_fast" }, operator: "GT", right: { kind: "indicator", id: "ema_slow" } },
          { left: { kind: "indicator", id: "rsi_14" }, operator: "LT", right: { kind: "constant", value: 70 } },
          { left: { kind: "indicator", id: "macd_main", field: "histogram" }, operator: "GT", right: { kind: "constant", value: 0 } },
        ],
      },
    },
    {
      // Mirror image for a downtrend entry.
      contractType: "PUT",
      when: {
        all: [
          { left: { kind: "indicator", id: "ema_fast" }, operator: "LT", right: { kind: "indicator", id: "ema_slow" } },
          { left: { kind: "indicator", id: "rsi_14" }, operator: "GT", right: { kind: "constant", value: 30 } },
          { left: { kind: "indicator", id: "macd_main", field: "histogram" }, operator: "LT", right: { kind: "constant", value: 0 } },
        ],
      },
    },
  ],
  staking: {
    mode: "MARTINGALE",
    baseStake: 1,
    multiplierOnLoss: 2,
    maxSteps: 5, // caps the ladder at a 32x base stake before the instance is forced to stop
    resetOnWin: true,
  },
  riskLimits: {
    // Conservative defaults for a 1-unit base stake; every BotInstance can — and for a REAL
    // account, should — override these with amounts sized to its own account and risk
    // tolerance (see BotInstance.riskParams, Task 4).
    stopLossAmount: 50,
    targetProfitAmount: 50,
    maxConsecutiveLosses: 5,
  },
  tradeParams: {
    durationValue: 5,
    durationUnit: "t", // tick-duration contracts — the common DBot pattern for this entry style
  },
};

export const emaRsiMacdMartingaleCatalogEntry = {
  key: EMA_RSI_MACD_MARTINGALE_KEY,
  name: "EMA Trend + RSI/MACD Confirmation (Martingale)",
  description:
    "Trades with the EMA(10/25) trend direction, filtered by RSI(14) momentum and confirmed by a MACD(12,26,9) histogram crossover. " +
    "Uses a martingale stake ladder (doubles the stake after a loss, resets after a win) with a configurable stop-loss and target-profit. " +
    "Default parameters are a reasonable starting point, not a recreation of any specific historical backtest — review and tune them before " +
    "running on a real account.",
  definition: emaRsiMacdMartingaleDefinition,
};
