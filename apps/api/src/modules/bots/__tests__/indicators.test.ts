import { describe, expect, it } from "vitest";
import { ema, macd, rsi, sma } from "../indicators.js";

describe("sma", () => {
  it("returns null until the window fills, then the moving average", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("rejects a non-positive period", () => {
    expect(() => sma([1, 2], 0)).toThrow();
  });
});

describe("ema", () => {
  it("seeds with the SMA of the first `period` values, then smooths", () => {
    // seed = (1+2+3)/3 = 2 at index 2; k = 2/(3+1) = 0.5
    // index3: 4*0.5 + 2*0.5 = 3; index4: 5*0.5 + 3*0.5 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("returns an all-null series when there isn't enough history yet", () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
  });
});

describe("rsi", () => {
  it("is 100 for a strictly increasing series (all gains, no losses)", () => {
    const out = rsi([1, 2, 3, 4, 5], 3);
    expect(out[3]).toBe(100);
    expect(out[4]).toBe(100);
    expect(out[0]).toBeNull();
  });

  it("is 0 for a strictly decreasing series (all losses, no gains)", () => {
    const out = rsi([5, 4, 3, 2, 1], 3);
    expect(out[3]).toBe(0);
    expect(out[4]).toBe(0);
  });

  it("sits at 50 for a flat series (no gains or losses at all)", () => {
    const out = rsi([5, 5, 5, 5, 5], 3);
    expect(out[3]).toBe(50);
  });
});

describe("macd", () => {
  it("histogram is always macd minus signal wherever both are defined", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.3);
    const { macd: macdLine, signal, histogram } = macd(closes, 12, 26, 9);
    expect(macdLine.length).toBe(closes.length);
    expect(signal.length).toBe(closes.length);
    expect(histogram.length).toBe(closes.length);

    for (let i = 0; i < closes.length; i++) {
      if (macdLine[i] !== null && signal[i] !== null) {
        expect(histogram[i]).toBeCloseTo(macdLine[i]! - signal[i]!, 10);
      } else {
        expect(histogram[i]).toBeNull();
      }
    }
    // With 60 points and a 26-period slow EMA + 9-period signal EMA, the histogram should be
    // defined well before the end of the series.
    expect(histogram[59]).not.toBeNull();
  });

  it("rejects a fast period that isn't shorter than the slow period", () => {
    expect(() => macd([1, 2, 3], 26, 12, 9)).toThrow();
  });
});
