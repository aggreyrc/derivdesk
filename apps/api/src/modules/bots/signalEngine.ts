// Evaluates a StrategyDefinition (strategy.schema.ts) against a candle series and returns at
// most one trade signal for the LATEST candle. Pure function — no Deriv calls, no DB, no
// state — so the bot runner (Phase 6 bots work) can call it on every evaluation tick and this
// file can be exhaustively unit tested with hand-built candle fixtures instead of live market
// data.

import type { Candle } from "../market/market.schemas.js";
import type { Condition, Operand, RuleNode, StrategyDefinition } from "./strategy.schema.js";
import { ema, macd, rsi, sma } from "./indicators.js";

type IndicatorSeries =
  | { kind: "single"; values: (number | null)[] }
  | { kind: "macd"; macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] };

function computeIndicators(definition: StrategyDefinition, candles: Candle[]): Map<string, IndicatorSeries> {
  const closes = candles.map((c) => c.close);
  const series = new Map<string, IndicatorSeries>();
  for (const spec of definition.indicators) {
    switch (spec.type) {
      case "SMA":
        series.set(spec.id, { kind: "single", values: sma(closes, spec.period) });
        break;
      case "EMA":
        series.set(spec.id, { kind: "single", values: ema(closes, spec.period) });
        break;
      case "RSI":
        series.set(spec.id, { kind: "single", values: rsi(closes, spec.period) });
        break;
      case "MACD": {
        const result = macd(closes, spec.fastPeriod, spec.slowPeriod, spec.signalPeriod);
        series.set(spec.id, { kind: "macd", ...result });
        break;
      }
    }
  }
  return series;
}

function resolveOperandAt(operand: Operand, index: number, candles: Candle[], indicators: Map<string, IndicatorSeries>): number | null {
  switch (operand.kind) {
    case "constant":
      return operand.value;
    case "price": {
      const candle = candles[index];
      return candle ? candle[operand.field] : null;
    }
    case "indicator": {
      const found = indicators.get(operand.id);
      if (!found) {
        throw new Error(`Strategy condition references unknown indicator id "${operand.id}"`);
      }
      if (found.kind === "single") return found.values[index] ?? null;
      const field = operand.field ?? "macd";
      return found[field][index] ?? null;
    }
  }
}

function evalCondition(condition: Condition, index: number, candles: Candle[], indicators: Map<string, IndicatorSeries>): boolean {
  const left = resolveOperandAt(condition.left, index, candles, indicators);
  const right = resolveOperandAt(condition.right, index, candles, indicators);
  // Not enough history for one side yet — never a signal, never an error. A strategy simply
  // stays dormant until its indicators have enough candles behind them.
  if (left === null || right === null) return false;

  switch (condition.operator) {
    case "GT":
      return left > right;
    case "LT":
      return left < right;
    case "GTE":
      return left >= right;
    case "LTE":
      return left <= right;
    case "EQ":
      return left === right;
    case "CROSSES_ABOVE":
    case "CROSSES_BELOW": {
      if (index === 0) return false;
      const prevLeft = resolveOperandAt(condition.left, index - 1, candles, indicators);
      const prevRight = resolveOperandAt(condition.right, index - 1, candles, indicators);
      if (prevLeft === null || prevRight === null) return false;
      return condition.operator === "CROSSES_ABOVE" ? prevLeft <= prevRight && left > right : prevLeft >= prevRight && left < right;
    }
  }
}

function evalNode(node: RuleNode, index: number, candles: Candle[], indicators: Map<string, IndicatorSeries>): boolean {
  if ("all" in node) return node.all.every((child) => evalNode(child, index, candles, indicators));
  if ("any" in node) return node.any.some((child) => evalNode(child, index, candles, indicators));
  return evalCondition(node, index, candles, indicators);
}

export interface StrategySignal {
  contractType: "CALL" | "PUT";
  ruleIndex: number;
}

/** Evaluates every entry rule, in order, against the latest candle. The first rule whose
 *  `when` tree is true wins; later rules are never reached that cycle. Returns null when no
 *  rule fires — "no trade this cycle" is the overwhelmingly common, and entirely expected,
 *  result of calling this. */
export function evaluateStrategy(definition: StrategyDefinition, candles: Candle[]): StrategySignal | null {
  if (candles.length === 0) return null;
  const indicators = computeIndicators(definition, candles);
  const lastIndex = candles.length - 1;

  for (let i = 0; i < definition.entryRules.length; i++) {
    const rule = definition.entryRules[i]!;
    if (evalNode(rule.when, lastIndex, candles, indicators)) {
      return { contractType: rule.contractType, ruleIndex: i };
    }
  }
  return null;
}
