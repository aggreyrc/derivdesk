import { describe, expect, it } from "vitest";
import { computeTechnical } from "../technical.js";
import { ema, rsi } from "../../bots/indicators.js";

const candles = (closes: number[]) => closes.map((close, i) => ({ epoch: i * 60, open: close, high: close, low: close, close }));
// Accelerating moves (quadratic), not straight lines: on a perfectly linear ramp the MACD
// histogram converges to ~0 and its sign is noise, so a linear fixture can't test the sign.
const rising = Array.from({ length: 120 }, (_, i) => 100 + 0.03 * i * i);
const falling = Array.from({ length: 120 }, (_, i) => 500 - 0.03 * i * i);

describe("computeTechnical", () => {
  it("returns series aligned one-to-one with the candles, null during warm-up", () => {
    const t = computeTechnical(candles(rising));
    expect(t.series.ema50).toHaveLength(120);
    expect(t.series.ema50[0]).toBeNull();
    expect(t.series.ema50[119]).not.toBeNull();
    expect(t.series.rsi14.slice(0, 5).every((v) => v === null)).toBe(true);
  });

  it("uses the same indicator maths the bots use", () => {
    const t = computeTechnical(candles(rising));
    expect(t.series.ema20).toEqual(ema(rising, 20));
    expect(t.series.rsi14).toEqual(rsi(rising, 14));
  });

  it("describes a steady uptrend without calling a direction", () => {
    const { readings } = computeTechnical(candles(rising));
    expect(readings).toMatchObject({ lastClose: rising[119], priceVsEma20: "above", priceVsEma50: "above", ema20VsEma50: "above" });
    expect(readings.rsi?.zone).toBe("above70");
    expect(readings.macd?.sign).toBe("positive");
  });

  it("describes a steady downtrend", () => {
    const { readings } = computeTechnical(candles(falling));
    expect(readings).toMatchObject({ priceVsEma20: "below", ema20VsEma50: "below" });
    expect(readings.rsi?.zone).toBe("below30");
    expect(readings.macd?.sign).toBe("negative");
  });

  it("flags a MACD histogram sign change on the latest candle only", () => {
    // accelerating decline (histogram negative) then a sharp final jump flips it positive on the last candle
    const closes = [...falling, 1000];
    const { readings } = computeTechnical(candles(closes));
    expect(readings.macd?.sign).toBe("positive");
    expect(readings.macd?.changedSignOnLastCandle).toBe(true);
    expect(computeTechnical(candles(falling)).readings.macd?.changedSignOnLastCandle).toBe(false);
  });

  it("gives null readings, not guesses, when there is too little history", () => {
    const { readings } = computeTechnical(candles([100, 101, 102]));
    expect(readings).toMatchObject({ priceVsEma50: null, ema20VsEma50: null, rsi: null, macd: null });
  });

  it("handles an empty series", () => {
    expect(computeTechnical([]).readings).toMatchObject({ lastClose: null, lastCandleEpoch: null, rsi: null, macd: null });
  });
});
