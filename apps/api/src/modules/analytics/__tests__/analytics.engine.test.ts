import { describe, expect, it } from "vitest";
import { computePerformance, computeSummary, normalizeRows, type ClosedTrade } from "../analytics.engine.js";

function trade(overrides: Partial<ClosedTrade> & { buyPrice: number; sellPrice: number; sellTime: number }): ClosedTrade {
  const { buyPrice, sellPrice } = overrides;
  return {
    contractId: overrides.sellTime,
    purchaseTime: overrides.sellTime - 10,
    pnl: Math.round((sellPrice - buyPrice) * 1e8) / 1e8,
    symbol: "R_100",
    contractType: "CALL",
    source: "MANUAL",
    ...overrides,
  };
}

// Hand-checked fixture: +9, -10, -10, +4.5, 0  (cumulative 9, -1, -11, -6.5, -6.5)
const fixture = [
  trade({ buyPrice: 10, sellPrice: 19, sellTime: 100 }),
  trade({ buyPrice: 10, sellPrice: 0, sellTime: 200 }),
  trade({ buyPrice: 10, sellPrice: 0, sellTime: 300 }),
  trade({ buyPrice: 5, sellPrice: 9.5, sellTime: 400 }),
  trade({ buyPrice: 5, sellPrice: 5, sellTime: 500 }),
];

describe("computeSummary", () => {
  it("matches the hand-computed figures", () => {
    expect(computeSummary(fixture)).toEqual({
      tradesCount: 5,
      wins: 2,
      losses: 2,
      breakeven: 1,
      winRate: 0.4,
      netPnl: -6.5,
      grossProfit: 13.5,
      grossLoss: 20,
      profitFactor: 0.675,
      averageWin: 6.75,
      averageLoss: 10,
      expectancy: -1.3,
      largestWin: 9,
      largestLoss: 10,
      totalStaked: 40,
      maxConsecutiveWins: 1,
      maxConsecutiveLosses: 2,
      maxDrawdown: 20, // peak 9 -> trough -11
    });
  });

  it("is independent of input order (orders by settlement itself)", () => {
    expect(computeSummary([...fixture].reverse())).toEqual(computeSummary(fixture));
  });

  it("returns nulls, not zeros or NaN, when there are no trades", () => {
    const s = computeSummary([]);
    expect(s).toMatchObject({ tradesCount: 0, winRate: null, profitFactor: null, averageWin: null, averageLoss: null, expectancy: null, largestWin: null, largestLoss: null, netPnl: 0, maxDrawdown: 0 });
  });

  it("leaves profit factor undefined (null) when nothing was ever lost", () => {
    const s = computeSummary([trade({ buyPrice: 1, sellPrice: 2, sellTime: 1 })]);
    expect(s.profitFactor).toBeNull();
    expect(s.winRate).toBe(1);
  });

  it("a breakeven trade breaks both streaks", () => {
    const s = computeSummary([
      trade({ buyPrice: 1, sellPrice: 2, sellTime: 1 }),
      trade({ buyPrice: 1, sellPrice: 2, sellTime: 2 }),
      trade({ buyPrice: 1, sellPrice: 1, sellTime: 3 }),
      trade({ buyPrice: 1, sellPrice: 2, sellTime: 4 }),
    ]);
    expect(s.maxConsecutiveWins).toBe(2);
  });

  it("doesn't leak floating-point noise into money figures", () => {
    const s = computeSummary([trade({ buyPrice: 0.1, sellPrice: 0.3, sellTime: 1 }), trade({ buyPrice: 0.1, sellPrice: 0.2, sellTime: 2 })]);
    expect(s.netPnl).toBe(0.3);
  });

  it("reports drawdown from the running peak, not from zero", () => {
    // +5, +5 (peak 10), -3, -3 (trough 4) → drawdown 6
    const s = computeSummary([
      trade({ buyPrice: 1, sellPrice: 6, sellTime: 1 }),
      trade({ buyPrice: 1, sellPrice: 6, sellTime: 2 }),
      trade({ buyPrice: 4, sellPrice: 1, sellTime: 3 }),
      trade({ buyPrice: 4, sellPrice: 1, sellTime: 4 }),
    ]);
    expect(s.maxDrawdown).toBe(6);
  });
});

describe("computePerformance", () => {
  it("builds a cumulative series in settlement order", () => {
    expect(computePerformance(fixture).series.map((p) => p.cumulative)).toEqual([9, -1, -11, -6.5, -6.5]);
  });

  it("groups by UTC day", () => {
    const day1 = Date.UTC(2026, 9, 1, 23, 59, 0) / 1000;
    const day2 = Date.UTC(2026, 9, 2, 0, 1, 0) / 1000;
    const p = computePerformance([trade({ buyPrice: 1, sellPrice: 2, sellTime: day1 }), trade({ buyPrice: 1, sellPrice: 0, sellTime: day2 })]);
    expect(p.byDay.map((d) => [d.key, d.netPnl])).toEqual([
      ["2026-10-01", 1],
      ["2026-10-02", -1],
    ]);
  });

  it("splits bot from manual and keeps unknown symbols visible instead of dropping them", () => {
    const p = computePerformance([
      trade({ buyPrice: 1, sellPrice: 2, sellTime: 1, source: "BOT" }),
      trade({ buyPrice: 1, sellPrice: 0, sellTime: 2, symbol: null, contractType: null }),
    ]);
    expect(p.bySource.map((r) => r.key).sort()).toEqual(["Bot", "Manual"]);
    expect(p.bySymbol.map((r) => r.key).sort()).toEqual(["R_100", "Unknown"]);
    expect(p.byContractType.map((r) => r.key).sort()).toEqual(["CALL", "Unknown"]);
  });
});

describe("normalizeRows", () => {
  it("computes P/L as sell minus buy, accepts string prices, and tags bot trades by contract id", () => {
    const { trades, excluded } = normalizeRows(
      [
        { contract_id: 1, transaction_id: 10, purchase_time: 100, sell_time: 110, buy_price: "10.00", sell_price: 19.5, underlying_symbol: "R_50", contract_type: "PUT" },
        { contract_id: 2, transaction_id: 11, purchase_time: 120, sell_time: 130, buy_price: 5, sell_price: 0 },
      ],
      new Set(["2"]),
    );
    expect(excluded).toBe(0);
    expect(trades[0]).toMatchObject({ pnl: 9.5, symbol: "R_50", contractType: "PUT", source: "MANUAL" });
    expect(trades[1]).toMatchObject({ pnl: -5, symbol: null, source: "BOT" });
  });

  it("excludes (and counts) rows Deriv gave without a usable settlement instead of guessing", () => {
    const { trades, excluded } = normalizeRows(
      [
        { contract_id: 1, transaction_id: 1, purchase_time: 1, sell_time: null, buy_price: 1, sell_price: 2 }, // not settled
        { contract_id: 2, transaction_id: 2, purchase_time: 1, sell_time: 5, buy_price: 1 }, // no sell price
        { contract_id: null, transaction_id: 3, purchase_time: 1, sell_time: 5, buy_price: 1, sell_price: 2 }, // no contract id
        { contract_id: 4, transaction_id: 4, purchase_time: 1, sell_time: 5, buy_price: "abc", sell_price: 2 }, // unparseable
        { contract_id: 5, transaction_id: 5, purchase_time: 1, sell_time: 5, buy_price: 1, sell_price: 2 },
      ],
      new Set(),
    );
    expect(trades).toHaveLength(1);
    expect(excluded).toBe(4);
  });
});
