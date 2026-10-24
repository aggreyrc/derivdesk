// Pure, dependency-free technical-indicator calculations used by the bot signal engine
// (signalEngine.ts) and, for the same reasons shared code is hand-mirrored elsewhere in this
// repo (see packages/shared-types/src/index.d.ts's header comment), potentially by a future
// Phase 7 analytics chart overlay. Every function here is a pure array-in/array-out
// transform — no Deriv calls, no I/O, no state — so it's cheap to unit test exhaustively and
// safe to call from both the bot runner (Phase 6 bots work) and, later, request handlers.
//
// Output arrays are always the same length as the input, with `null` in positions where the
// indicator isn't yet defined (not enough history) — callers index by candle position rather
// than re-deriving an offset.

export function sma(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error("period must be positive");
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error("period must be positive");
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values (standard convention — Wilder's and most
  // charting packages seed this way rather than starting EMA from the very first sample).
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  seed /= period;
  out[period - 1] = seed;

  let prev = seed;
  for (let i = period; i < values.length; i++) {
    const next = values[i]! * k + prev * (1 - k);
    out[i] = next;
    prev = next;
  }
  return out;
}

// Wilder's RSI — the original and most common RSI smoothing (average gain/loss smoothed with
// a 1/period running average rather than a plain SMA after the seed window).
export function rsi(values: number[], period = 14): (number | null)[] {
  if (period <= 0) throw new Error("period must be positive");
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gainSum += change;
    else lossSum += -change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    const gain = change >= 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

export function macd(values: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): MacdResult {
  if (fastPeriod >= slowPeriod) throw new Error("fastPeriod must be less than slowPeriod");
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);

  const macdLine: (number | null)[] = values.map((_, i) => {
    const f = fast[i] ?? null;
    const s = slow[i] ?? null;
    return f === null || s === null ? null : f - s;
  });

  // The signal line is an EMA of the MACD line itself, but ema() needs a contiguous numeric
  // array — so we compute it over just the defined (non-null) tail and splice the result back
  // into a full-length array aligned to the original candles.
  const firstDefined = macdLine.findIndex((v) => v !== null);
  const signalLine: (number | null)[] = new Array(values.length).fill(null);
  if (firstDefined !== -1) {
    const tail = macdLine.slice(firstDefined) as number[];
    const signalTail = ema(tail, signalPeriod);
    for (let i = 0; i < signalTail.length; i++) signalLine[firstDefined + i] = signalTail[i] ?? null;
  }

  const histogram: (number | null)[] = values.map((_, i) => {
    const m = macdLine[i] ?? null;
    const s = signalLine[i] ?? null;
    return m === null || s === null ? null : m - s;
  });

  return { macd: macdLine, signal: signalLine, histogram };
}
