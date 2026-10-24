// Starter definition for "New strategy". A deliberate copy of the built-in EMA/RSI/MACD
// martingale strategy in apps/api (strategies/emaRsiMacdMartingale.ts) so an admin can tweak a
// known-valid example instead of writing the format from a blank box. The server (admin-api,
// Zod) remains the only authority on what is valid — this is a convenience, not a validator.
export const STRATEGY_KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const STARTER_DEFINITION = {
  candleGranularitySeconds: 60,
  indicators: [
    { id: "ema_fast", type: "EMA", period: 10 },
    { id: "ema_slow", type: "EMA", period: 25 },
    { id: "rsi_14", type: "RSI", period: 14 },
    { id: "macd_main", type: "MACD", fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  ],
  entryRules: [
    {
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
  staking: { mode: "MARTINGALE", baseStake: 1, multiplierOnLoss: 2, maxSteps: 5, resetOnWin: true },
  riskLimits: { stopLossAmount: 50, targetProfitAmount: 50, maxConsecutiveLosses: 5 },
  tradeParams: { durationValue: 5, durationUnit: "t" },
};
