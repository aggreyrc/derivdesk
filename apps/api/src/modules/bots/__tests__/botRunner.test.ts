import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@derivdesk/db";
import { BotRunner } from "../botRunner.js";

// A trivial strategy that signals CALL on any closed candle, so these tests exercise the
// runner's own decisions (one trade at a time, stake ladder, kill switches, fail-closed
// behaviour) without depending on indicator maths — that's covered by signalEngine.test.ts.
const definition = {
  candleGranularitySeconds: 60,
  indicators: [{ id: "sma", type: "SMA", period: 2 }],
  entryRules: [{ contractType: "CALL", when: { left: { kind: "price", field: "close" }, operator: "GT", right: { kind: "constant", value: 0 } } }],
  staking: { mode: "FIXED", stake: 1 },
  riskLimits: {},
  tradeParams: { durationValue: 5, durationUnit: "t" },
};

const riskParams = {
  staking: { mode: "MARTINGALE", baseStake: 1, multiplierOnLoss: 2, maxSteps: 4, resetOnWin: true },
  riskLimits: { stopLossAmount: 20, targetProfitAmount: 5 },
};

const NOW_SEC = 600;
const closedCandles = Array.from({ length: 10 }, (_, i) => ({ epoch: i * 60, open: 1, high: 2, low: 1, close: 1.5 }));
const formingCandle = { epoch: 600, open: 1, high: 2, low: 1, close: 1.5 };

function makeInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: "bot_1",
    userId: "user_1",
    derivAccountId: "acc_1",
    strategyId: "strat_1",
    name: "Test bot",
    symbol: "R_100",
    riskParams,
    confirmReal: false,
    status: "RUNNING",
    stopReason: null,
    stakingState: { currentStep: 0 },
    riskState: { sessionProfitLoss: 0, consecutiveLosses: 0, tradesCount: 0 },
    strategy: { id: "strat_1", definition },
    derivAccount: { id: "acc_1", derivAccountId: "VRTC1", accountType: "DEMO", currency: "USD", status: "active" },
    user: { handle: "CR1000001" },
    ...overrides,
  };
}

function setup(instanceOverrides: Record<string, unknown> = {}) {
  const instance = makeInstance(instanceOverrides);
  const db = {
    botInstance: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockImplementation(async () => instance),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => Object.assign(instance, data)),
    },
    botTrade: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "trade_1" }),
      update: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaClient;

  let positionCallback: ((c: Record<string, unknown>) => void) | null = null;
  const unsubscribe = vi.fn();
  const market = {
    getCandles: vi.fn().mockResolvedValue({ candles: [...closedCandles, formingCandle], pipSize: 2 }),
    getProposal: vi.fn().mockResolvedValue({ id: "prop_1", ask_price: 1 }),
  };
  const trading = {
    buy: vi.fn().mockResolvedValue({ contract_id: 777, transaction_id: 888, purchase_time: 600, buy_price: 1 }),
    subscribePosition: vi.fn().mockImplementation((_u: string, _a: string, _c: number, cb: (c: Record<string, unknown>) => void) => {
      positionCallback = cb;
      return unsubscribe;
    }),
  };
  const audit = vi.fn().mockResolvedValue(undefined);
  const runner = new BotRunner({ db, market: market as never, trading: trading as never, audit, now: () => NOW_SEC * 1000 });
  return { runner, db, instance, market, trading, audit, unsubscribe, settle: (c: Record<string, unknown>) => positionCallback!(c) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("BotRunner — placing trades", () => {
  it("places a trade on a signal using the account's own currency and the configured ladder stake", async () => {
    const { runner, market, trading, db, audit } = setup();
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");

    expect(market.getProposal).toHaveBeenCalledWith(expect.objectContaining({ contract_type: "CALL", underlying_symbol: "R_100", currency: "USD", amount: 1, basis: "stake", duration: 5, duration_unit: "t" }));
    expect(trading.buy).toHaveBeenCalledWith("user_1", "VRTC1", "prop_1", 1);
    expect(db.botTrade.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ botInstanceId: "bot_1", contractId: "777", status: "OPEN", stakeStep: 0 }) }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "bots.trade_placed" }));
    runner.shutdown();
  });

  it("ignores the still-forming candle and evaluates each closed candle only once", async () => {
    const { runner, market, trading } = setup();
    market.getCandles.mockResolvedValue({ candles: [{ epoch: 540, open: 1, high: 1, low: 1, close: 1 }, formingCandle], pipSize: 2 });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    expect(trading.buy).toHaveBeenCalledTimes(1);

    // Same latest closed candle again (the open trade also blocks it) — must not trade twice.
    await runner.evaluateOnce("bot_1");
    expect(trading.buy).toHaveBeenCalledTimes(1);
    runner.shutdown();
  });

  it("refuses a trade whose quoted price exceeds the configured stake", async () => {
    const { runner, market, trading } = setup();
    market.getProposal.mockResolvedValue({ id: "prop_1", ask_price: 1.5 });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    expect(trading.buy).not.toHaveBeenCalled();
    runner.shutdown();
  });

  it("stops a real-money bot that was never explicitly confirmed", async () => {
    const { runner, trading, db } = setup({ derivAccount: { id: "acc_1", derivAccountId: "CR1", accountType: "REAL", currency: "USD", status: "active" }, confirmReal: false });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    expect(trading.buy).not.toHaveBeenCalled();
    expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "STOPPED", stopReason: "REAL_ACCOUNT_NOT_CONFIRMED" }) }));
    expect(runner.isAttached("bot_1")).toBe(false);
  });

  it("detaches without trading when the instance is no longer RUNNING", async () => {
    const { runner, trading } = setup({ status: "PAUSED" });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    expect(trading.buy).not.toHaveBeenCalled();
    expect(runner.isAttached("bot_1")).toBe(false);
  });

  it("errors the instance when its stored configuration no longer validates", async () => {
    const { runner, trading, db } = setup({ riskParams: { staking: { mode: "FIXED", stake: 1 }, riskLimits: {} } }); // no kill switch
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    expect(trading.buy).not.toHaveBeenCalled();
    expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ERROR", stopReason: "INVALID_CONFIGURATION" }) }));
  });
});

describe("BotRunner — settlement and kill switches", () => {
  it("climbs the martingale ladder after a loss", async () => {
    const { runner, db, settle, unsubscribe } = setup();
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");

    settle({ is_sold: 1, profit: "-1.00", payout: "0" });
    await vi.waitFor(() =>
      expect(db.botInstance.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { stakingState: { currentStep: 1 }, riskState: { sessionProfitLoss: -1, consecutiveLosses: 1, tradesCount: 1 } } }),
      ),
    );
    expect(db.botTrade.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CLOSED", profit: "-1" }) }));
    expect(unsubscribe).toHaveBeenCalled();
    runner.shutdown();
  });

  it("stops the bot when target profit is reached", async () => {
    const { runner, db, settle, audit } = setup({ riskState: { sessionProfitLoss: 4, consecutiveLosses: 0, tradesCount: 3 } });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");

    settle({ is_sold: 1, profit: "1.95", payout: "1.95" });
    await vi.waitFor(() => expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "STOPPED", stopReason: "TARGET_PROFIT_REACHED" }) })));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "bots.stopped", metadata: { reason: "TARGET_PROFIT_REACHED" } }));
    expect(runner.isAttached("bot_1")).toBe(false);
  });

  it("stops at the stop-loss", async () => {
    const { runner, db, settle } = setup({ riskState: { sessionProfitLoss: -19.5, consecutiveLosses: 2, tradesCount: 4 } });
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");

    settle({ is_sold: 1, profit: "-1", payout: "0" });
    await vi.waitFor(() => expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "STOPPED", stopReason: "STOP_LOSS_REACHED" }) })));
  });

  it("errors instead of guessing when a trade never settles", async () => {
    const { runner, db } = setup();
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");

    await vi.advanceTimersByTimeAsync(10_000 + 120_000 + 1);
    await vi.waitFor(() => expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ERROR", stopReason: "SETTLEMENT_NOT_CONFIRMED" }) })));
  });
});

describe("BotRunner — failure handling", () => {
  it("errors immediately when Deriv needs re-authorisation", async () => {
    const { runner, db, trading } = setup();
    trading.buy.mockRejectedValue(Object.assign(new Error("reauth"), { code: "ReauthRequired" }));
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ERROR", stopReason: "REAUTH_REQUIRED" }) }));
  });

  it("tolerates transient errors but stops after five in a row", async () => {
    const { runner, db, market } = setup();
    market.getCandles.mockRejectedValue(new Error("network blip"));
    await runner.attach("bot_1", { evaluateImmediately: false });

    for (let i = 0; i < 4; i++) await runner.evaluateOnce("bot_1");
    expect(runner.isAttached("bot_1")).toBe(true);

    await runner.evaluateOnce("bot_1");
    expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ERROR", stopReason: "TOO_MANY_ERRORS" }) }));
    expect(runner.isAttached("bot_1")).toBe(false);
  });

  it("resumes RUNNING instances and their open trades after a restart", async () => {
    const { runner, db, trading } = setup();
    (db.botInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "bot_1" }]);
    (db.botTrade.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "trade_9", contractId: "555", stake: "1", stakeStep: 2, status: "OPEN" });

    await runner.start();

    expect(runner.isAttached("bot_1")).toBe(true);
    expect(trading.subscribePosition).toHaveBeenCalledWith("user_1", "VRTC1", 555, expect.any(Function));
    runner.shutdown();
  });
});

describe("BotRunner — pausing with a trade open", () => {
  it("keeps watching the open trade, records the outcome, then detaches without overwriting the user's status", async () => {
    const { runner, db, instance, settle } = setup();
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1"); // trade now open

    instance.status = "PAUSED"; // user pauses mid-trade
    runner.release("bot_1");
    expect(runner.isAttached("bot_1")).toBe(true); // still watching real money

    settle({ is_sold: 1, profit: "-1", payout: "0" });
    await vi.waitFor(() => expect(runner.isAttached("bot_1")).toBe(false));

    expect(db.botTrade.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ profit: "-1" }) }));
    const statusWrites = (db.botInstance.update as ReturnType<typeof vi.fn>).mock.calls.filter(([a]) => "status" in a.data);
    expect(statusWrites).toHaveLength(0);
  });

  it("detaches at once when nothing is open", async () => {
    const { runner } = setup();
    await runner.attach("bot_1", { evaluateImmediately: false });
    runner.release("bot_1");
    expect(runner.isAttached("bot_1")).toBe(false);
  });
});
