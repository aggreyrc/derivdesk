import { describe, expect, it } from "vitest";
import type { Candle } from "../../market/market.schemas.js";
import { evaluateStrategy } from "../signalEngine.js";
import type { StrategyDefinition } from "../strategy.schema.js";
import { emaRsiMacdMartingaleDefinition } from "../strategies/emaRsiMacdMartingale.js";

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((close, i) => ({ epoch: i * 60, open: close, high: close, low: close, close }));
}

const crossoverDefinition: StrategyDefinition = {
  candleGranularitySeconds: 60,
  indicators: [
    { id: "fast", type: "SMA", period: 2 },
    { id: "slow", type: "SMA", period: 3 },
  ],
  entryRules: [
    { contractType: "CALL", when: { left: { kind: "indicator", id: "fast" }, operator: "CROSSES_ABOVE", right: { kind: "indicator", id: "slow" } } },
    { contractType: "PUT", when: { left: { kind: "indicator", id: "fast" }, operator: "CROSSES_BELOW", right: { kind: "indicator", id: "slow" } } },
  ],
  staking: { mode: "FIXED", stake: 1 },
  riskLimits: {},
  tradeParams: { durationValue: 5, durationUnit: "t" },
};

describe("evaluateStrategy — crossovers", () => {
  it("fires CALL when the fast average crosses above the slow one on the latest candle", () => {
    // sma2: […, idx4=7.5, idx5=12.5]; sma3: […, idx4=8.33, idx5=11.67] — fast was below, now above.
    const candles = candlesFromCloses([10, 10, 10, 10, 5, 20]);
    expect(evaluateStrategy(crossoverDefinition, candles)).toEqual({ contractType: "CALL", ruleIndex: 0 });
  });

  it("fires PUT when the fast average crosses below the slow one on the latest candle", () => {
    // sma2: […, idx4=15, idx5=6]; sma3: […, idx4=13.33, idx5=10.67] — fast was above, now below.
    const candles = candlesFromCloses([10, 10, 10, 20, 10, 2]);
    expect(evaluateStrategy(crossoverDefinition, candles)).toEqual({ contractType: "PUT", ruleIndex: 1 });
  });

  it("returns null when neither rule's condition is true on the latest candle", () => {
    const candles = candlesFromCloses([10, 10, 10, 10, 10, 10]);
    expect(evaluateStrategy(crossoverDefinition, candles)).toBeNull();
  });

  it("returns null (never a signal) while indicators don't have enough history yet", () => {
    expect(evaluateStrategy(crossoverDefinition, candlesFromCloses([10, 11]))).toBeNull();
  });

  it("returns null for an empty candle series", () => {
    expect(evaluateStrategy(crossoverDefinition, [])).toBeNull();
  });
});

describe("evaluateStrategy — rule trees and operands", () => {
  it("evaluates nested all/any groups and the price/constant operands", () => {
    const definition: StrategyDefinition = {
      ...crossoverDefinition,
      entryRules: [
        {
          contractType: "CALL",
          when: {
            all: [
              { left: { kind: "price", field: "close" }, operator: "GT", right: { kind: "constant", value: 15 } },
              { any: [{ left: { kind: "constant", value: 1 }, operator: "EQ", right: { kind: "constant", value: 2 } }, { left: { kind: "indicator", id: "fast" }, operator: "CROSSES_ABOVE", right: { kind: "indicator", id: "slow" } }] },
            ],
          },
        },
      ],
    };
    const candles = candlesFromCloses([10, 10, 10, 10, 5, 20]); // close=20 > 15, and the fast/slow cross still holds
    expect(evaluateStrategy(definition, candles)).toEqual({ contractType: "CALL", ruleIndex: 0 });
  });

  it("throws when a condition references an indicator id that isn't in the definition", () => {
    const definition: StrategyDefinition = {
      ...crossoverDefinition,
      entryRules: [{ contractType: "CALL", when: { left: { kind: "indicator", id: "nope" }, operator: "GT", right: { kind: "constant", value: 0 } } }],
    };
    expect(() => evaluateStrategy(definition, candlesFromCloses([1, 2, 3]))).toThrow(/unknown indicator/i);
  });

  it("only the first matching rule fires — later rules in the list are never reached", () => {
    const definition: StrategyDefinition = {
      ...crossoverDefinition,
      entryRules: [
        { contractType: "CALL", when: { left: { kind: "constant", value: 1 }, operator: "EQ", right: { kind: "constant", value: 1 } } },
        { contractType: "PUT", when: { left: { kind: "constant", value: 1 }, operator: "EQ", right: { kind: "constant", value: 1 } } },
      ],
    };
    expect(evaluateStrategy(definition, candlesFromCloses([1, 2, 3]))?.contractType).toBe("CALL");
  });
});

describe("evaluateStrategy — the built-in EMA/RSI/MACD martingale strategy", () => {
  it("never throws and only ever signals CALL (never PUT) across a sustained, noisy uptrend", () => {
    const closes = Array.from({ length: 70 }, (_, i) => 100 + i * 0.3 + Math.sin(i / 3) * 3);
    const candles = candlesFromCloses(closes);

    let sawCall = false;
    for (let n = 30; n <= candles.length; n++) {
      const signal = evaluateStrategy(emaRsiMacdMartingaleDefinition, candles.slice(0, n));
      expect(signal === null || signal.contractType === "CALL" || signal.contractType === "PUT").toBe(true);
      if (signal?.contractType === "CALL") sawCall = true;
      expect(signal?.contractType).not.toBe("PUT");
    }
    // The strategy should actually be capable of firing — not silently always null — somewhere
    // across a clear, sustained uptrend; otherwise the wiring between its indicators and rules
    // would be untested.
    expect(sawCall).toBe(true);
  });

  it("never throws across a sustained, noisy downtrend", () => {
    const closes = Array.from({ length: 70 }, (_, i) => 200 - i * 0.3 + Math.sin(i / 3) * 3);
    const candles = candlesFromCloses(closes);

    for (let n = 30; n <= candles.length; n++) {
      expect(() => evaluateStrategy(emaRsiMacdMartingaleDefinition, candles.slice(0, n))).not.toThrow();
    }
  });
});
