// Technical-analysis view of a candle series: indicator series for charting plus a few plain
// DESCRIPTIVE readings of where the indicators currently sit. It deliberately does not say
// "buy", "sell" or "likely to rise" — an indicator reading is a description of recent price
// history, not a forecast, and this app doesn't pretend otherwise.
//
// Uses the exact indicator functions the bot signal engine uses (../bots/indicators.ts), so a
// chart here and a bot's decision can never disagree about what an EMA or RSI value is.

import type { Candle } from "../market/market.schemas.js";
import { ema, macd, rsi, sma } from "../bots/indicators.js";

// Fixed, conventional parameters. Fixed on purpose: arbitrary user-chosen periods would invite
// fitting the chart to a desired story, and every figure stays reproducible.
export const TECHNICAL_PARAMS = { sma: 20, emaFast: 20, emaSlow: 50, rsi: 14, macd: { fast: 12, slow: 26, signal: 9 } } as const;

export interface TechnicalSeries {
  sma20: (number | null)[];
  ema20: (number | null)[];
  ema50: (number | null)[];
  rsi14: (number | null)[];
  macd: { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] };
}

export interface TechnicalReadings {
  lastClose: number | null;
  /** Epoch seconds of the latest candle — which may still be forming. */
  lastCandleEpoch: number | null;
  priceVsEma20: "above" | "below" | "equal" | null;
  priceVsEma50: "above" | "below" | "equal" | null;
  ema20VsEma50: "above" | "below" | "equal" | null;
  rsi: { value: number; zone: "above70" | "below30" | "between30and70" } | null;
  macd: { histogram: number; sign: "positive" | "negative" | "zero"; changedSignOnLastCandle: boolean } | null;
}

export interface TechnicalAnalysis {
  params: typeof TECHNICAL_PARAMS;
  candles: Candle[];
  series: TechnicalSeries;
  readings: TechnicalReadings;
}

const compare = (a: number | null | undefined, b: number | null | undefined): "above" | "below" | "equal" | null => {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return a > b ? "above" : a < b ? "below" : "equal";
};

const signOf = (n: number): "positive" | "negative" | "zero" => (n > 0 ? "positive" : n < 0 ? "negative" : "zero");

export function computeTechnical(candles: Candle[]): TechnicalAnalysis {
  const closes = candles.map((c) => c.close);
  const m = macd(closes, TECHNICAL_PARAMS.macd.fast, TECHNICAL_PARAMS.macd.slow, TECHNICAL_PARAMS.macd.signal);
  const series: TechnicalSeries = {
    sma20: sma(closes, TECHNICAL_PARAMS.sma),
    ema20: ema(closes, TECHNICAL_PARAMS.emaFast),
    ema50: ema(closes, TECHNICAL_PARAMS.emaSlow),
    rsi14: rsi(closes, TECHNICAL_PARAMS.rsi),
    macd: { macd: m.macd, signal: m.signal, histogram: m.histogram },
  };

  const last = candles.length - 1;
  const at = (arr: (number | null)[], i: number) => (i >= 0 ? (arr[i] ?? null) : null);
  const lastClose = last >= 0 ? closes[last]! : null;
  const rsiNow = at(series.rsi14, last);
  const histNow = at(series.macd.histogram, last);
  const histPrev = at(series.macd.histogram, last - 1);

  const readings: TechnicalReadings = {
    lastClose,
    lastCandleEpoch: last >= 0 ? candles[last]!.epoch : null,
    priceVsEma20: compare(lastClose, at(series.ema20, last)),
    priceVsEma50: compare(lastClose, at(series.ema50, last)),
    ema20VsEma50: compare(at(series.ema20, last), at(series.ema50, last)),
    rsi: rsiNow === null ? null : { value: rsiNow, zone: rsiNow > 70 ? "above70" : rsiNow < 30 ? "below30" : "between30and70" },
    macd:
      histNow === null
        ? null
        : {
            histogram: histNow,
            sign: signOf(histNow),
            changedSignOnLastCandle: histPrev !== null && signOf(histPrev) !== signOf(histNow) && histPrev !== 0 && histNow !== 0,
          },
  };

  return { params: TECHNICAL_PARAMS, candles, series, readings };
}
