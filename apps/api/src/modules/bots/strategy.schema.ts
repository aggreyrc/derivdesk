// The general bot-strategy definition format (per the user's "general framework" choice —
// see README's bot section). A `StrategyDefinition` is admin-authored JSON stored on
// `BotStrategy.definition`; the signal engine (signalEngine.ts) is the only code that
// interprets it. Adding a genuinely new strategy — different indicator combination, different
// entry logic, different staking shape — is a *data* change (a new BotStrategy row), not a
// code change, as long as it's expressible in terms of the indicator types and comparisons
// defined here. A fundamentally new indicator type (e.g. Bollinger Bands) still needs a new
// case added to indicators.ts + signalEngine.ts — that boundary is documented in the bots
// README section, not hidden.
//
// Deliberately NOT an arbitrary expression language (no eval, no user-supplied code): every
// condition is a fixed shape the engine walks itself, so a malformed or malicious definition
// can only fail Zod validation, never execute as code.

import { z } from "zod";

export const indicatorSpecSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("SMA"), period: z.number().int().positive() }),
  z.object({ id: z.string().min(1), type: z.literal("EMA"), period: z.number().int().positive() }),
  z.object({ id: z.string().min(1), type: z.literal("RSI"), period: z.number().int().positive().default(14) }),
  z.object({
    id: z.string().min(1),
    type: z.literal("MACD"),
    fastPeriod: z.number().int().positive().default(12),
    slowPeriod: z.number().int().positive().default(26),
    signalPeriod: z.number().int().positive().default(9),
  }),
]);
export type IndicatorSpec = z.infer<typeof indicatorSpecSchema>;

const macdField = z.enum(["macd", "signal", "histogram"]);

export const operandSchema = z.union([
  // References an indicator by its `id` from StrategyDefinition.indicators. `field` only
  // applies to MACD (which produces three series); every other indicator type is single-valued
  // and ignores it.
  z.object({ kind: z.literal("indicator"), id: z.string().min(1), field: macdField.optional() }),
  z.object({ kind: z.literal("price"), field: z.enum(["open", "high", "low", "close"]) }),
  z.object({ kind: z.literal("constant"), value: z.number() }),
]);
export type Operand = z.infer<typeof operandSchema>;

export const conditionSchema = z.object({
  left: operandSchema,
  // GT/LT/GTE/LTE/EQ compare the latest value of each side. CROSSES_ABOVE/CROSSES_BELOW
  // compare the latest two candles — left was <= right (resp. >=) one candle ago and is now
  // > right (resp. <) — the standard "crossover" signal, not just a snapshot comparison.
  operator: z.enum(["GT", "LT", "GTE", "LTE", "EQ", "CROSSES_ABOVE", "CROSSES_BELOW"]),
  right: operandSchema,
});
export type Condition = z.infer<typeof conditionSchema>;

// A small boolean-logic tree over conditions. Exactly one of `all`/`any` per node — not both —
// kept as two variants rather than one object with two optional arrays so a definition can't
// accidentally specify both and leave which one wins ambiguous.
export type RuleNode = Condition | { all: RuleNode[] } | { any: RuleNode[] };

export const ruleNodeSchema: z.ZodType<RuleNode> = z.lazy(() =>
  z.union([conditionSchema, z.object({ all: z.array(ruleNodeSchema).min(1) }), z.object({ any: z.array(ruleNodeSchema).min(1) })]),
);

export const entryRuleSchema = z.object({
  // Deriv's basic rise/fall contract types — the DBot source strategy trades these; a
  // strategy wanting a different contract type (digits, touch/no-touch, …) is a future
  // extension, not something this engine evaluates today (documented limitation).
  contractType: z.enum(["CALL", "PUT"]),
  when: ruleNodeSchema,
});
export type EntryRule = z.infer<typeof entryRuleSchema>;

export const stakingConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("FIXED"), stake: z.number().positive() }),
  z.object({
    mode: z.literal("MARTINGALE"),
    baseStake: z.number().positive(),
    // multiplier applied to the PREVIOUS stake after a loss (the DBot source strategy's
    // "double on loss, reset on win" pattern is multiplierOnLoss: 2).
    multiplierOnLoss: z.number().gt(1),
    maxSteps: z.number().int().positive(), // caps how many losses in a row the ladder climbs before forcing a stop
    resetOnWin: z.boolean().default(true),
  }),
]);
export type StakingConfig = z.infer<typeof stakingConfigSchema>;

export const riskLimitsSchema = z.object({
  // All amounts are in the account's own currency, resolved server-side — never trusted from
  // the client — exactly like every other money figure in this app (see trading/payments
  // modules' "never trust frontend-supplied balances" comments).
  stopLossAmount: z.number().positive().optional(), // kill the instance once session P/L <= -this
  targetProfitAmount: z.number().positive().optional(), // kill the instance once session P/L >= this
  maxConsecutiveLosses: z.number().int().positive().optional(), // independent of the staking ladder's own maxSteps
  maxTradesPerSession: z.number().int().positive().optional(),
});
export type RiskLimits = z.infer<typeof riskLimitsSchema>;

export const strategyDefinitionSchema = z.object({
  // Candle granularity the engine evaluates indicators against, in seconds (Deriv's own
  // candle/ohlc granularity values — 60 = 1 minute, matching ticks_history's `granularity`).
  candleGranularitySeconds: z.number().int().positive(),
  indicators: z.array(indicatorSpecSchema).min(1),
  // Evaluated in order; the first rule whose `when` is true wins and fires that contractType.
  // No match on a given evaluation = no trade this cycle, not an error.
  entryRules: z.array(entryRuleSchema).min(1),
  staking: stakingConfigSchema,
  riskLimits: riskLimitsSchema.default({}),
  tradeParams: z.object({
    durationValue: z.number().int().positive(),
    durationUnit: z.enum(["t", "s", "m", "h", "d"]), // Deriv's own duration_unit values (t = ticks)
  }),
});
export type StrategyDefinition = z.infer<typeof strategyDefinitionSchema>;
