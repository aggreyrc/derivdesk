import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@derivdesk/db";
import { BotRunner } from "../botRunner.js";

// Leader-gating behaviour of the runner (see lib/runnerLease.ts). The point: with several API
// instances only the lease holder may attach, evaluate or place an order.

const definition = {
  candleGranularitySeconds: 60,
  indicators: [{ id: "sma", type: "SMA", period: 2 }],
  entryRules: [{ contractType: "CALL", when: { left: { kind: "price", field: "close" }, operator: "GT", right: { kind: "constant", value: 0 } } }],
  staking: { mode: "FIXED", stake: 1 },
  riskLimits: {},
  tradeParams: { durationValue: 5, durationUnit: "t" },
};
const riskParams = { staking: { mode: "MARTINGALE", baseStake: 1, multiplierOnLoss: 2, maxSteps: 4, resetOnWin: true }, riskLimits: { stopLossAmount: 20, targetProfitAmount: 5 } };
const candles = Array.from({ length: 10 }, (_, i) => ({ epoch: i * 60, open: 1, high: 2, low: 1, close: 1.5 }));

function setup(leader = { held: true }) {
  const instance: Record<string, unknown> = {
    id: "bot_1", userId: "user_1", derivAccountId: "acc_1", strategyId: "s", name: "b", symbol: "R_100", riskParams, confirmReal: false,
    status: "RUNNING", stopReason: null, stakingState: { currentStep: 0 }, riskState: { sessionProfitLoss: 0, consecutiveLosses: 0, tradesCount: 0 },
    strategy: { id: "s", definition },
    derivAccount: { id: "acc_1", derivAccountId: "VRTC1", accountType: "DEMO", currency: "USD", status: "active" },
    user: { handle: "CR1000001" },
  };
  const running = [{ id: "bot_1" }];
  const db = {
    botInstance: {
      findMany: vi.fn().mockImplementation(async () => running),
      findUnique: vi.fn().mockImplementation(async () => instance),
      update: vi.fn().mockResolvedValue({}),
    },
    botTrade: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "t1" }), update: vi.fn().mockResolvedValue({}) },
  } as unknown as PrismaClient;
  const market = { getCandles: vi.fn().mockResolvedValue({ candles: [...candles, { epoch: 600, open: 1, high: 2, low: 1, close: 1.5 }], pipSize: 2 }), getProposal: vi.fn().mockResolvedValue({ id: "p", ask_price: 1 }) };
  const trading = {
    buy: vi.fn().mockResolvedValue({ contract_id: 7, transaction_id: 8, purchase_time: 600, buy_price: 1 }),
    subscribePosition: vi.fn().mockReturnValue(() => undefined),
  };
  const runner = new BotRunner({ db, market: market as never, trading: trading as never, audit: vi.fn().mockResolvedValue(undefined), now: () => 600_000, canTrade: () => leader.held });
  return { runner, db, market, trading, leader, running };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("BotRunner — leader gating", () => {
  it("a non-leader never attaches a bot, even when asked directly (e.g. via POST /bots/:id/start)", async () => {
    const { runner, trading, market } = setup({ held: false });
    await runner.attach("bot_1");
    expect(runner.isAttached("bot_1")).toBe(false);
    await runner.evaluateOnce("bot_1");
    expect(market.getCandles).not.toHaveBeenCalled();
    expect(trading.buy).not.toHaveBeenCalled();
  });

  it("start() on a non-leader attaches nothing and reconcile is a no-op", async () => {
    const { runner, db } = setup({ held: false });
    await runner.reconcile();
    expect(db.botInstance.findMany).not.toHaveBeenCalled();
    expect(runner.isAttached("bot_1")).toBe(false);
    runner.shutdown();
  });

  it("the leader's reconcile attaches a bot that another instance just started", async () => {
    const { runner } = setup();
    expect(runner.isAttached("bot_1")).toBe(false);
    await runner.reconcile(); // the DB says bot_1 is RUNNING
    expect(runner.isAttached("bot_1")).toBe(true);
    runner.shutdown();
  });

  it("the leader's reconcile lets go of a bot that was paused/stopped through another instance", async () => {
    const { runner, running } = setup();
    await runner.reconcile();
    expect(runner.isAttached("bot_1")).toBe(true);
    running.length = 0; // no longer RUNNING in the database
    await runner.reconcile();
    expect(runner.isAttached("bot_1")).toBe(false);
  });

  it("the periodic reconcile loop runs after start() and stops on shutdown()", async () => {
    const { runner, db } = setup();
    await runner.start({ reconcileEveryMs: 1000 });
    const callsAfterStart = (db.botInstance.findMany as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(3100);
    expect((db.botInstance.findMany as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsAfterStart);
    runner.shutdown();
    const after = (db.botInstance.findMany as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect((db.botInstance.findMany as ReturnType<typeof vi.fn>).mock.calls.length).toBe(after);
  });

  it("does NOT place the order if leadership lapses between the signal and the buy", async () => {
    const { runner, market, trading, leader, db } = setup();
    await runner.attach("bot_1", { evaluateImmediately: false });
    // Leadership is lost while the proposal request is in flight.
    market.getProposal.mockImplementation(async () => {
      leader.held = false;
      return { id: "p", ask_price: 1 };
    });
    await runner.evaluateOnce("bot_1");
    expect(market.getProposal).toHaveBeenCalled();
    expect(trading.buy).not.toHaveBeenCalled();
    expect(db.botTrade.create).not.toHaveBeenCalled();
    runner.shutdown();
  });

  it("still trades normally while it holds the lease", async () => {
    const { runner, trading } = setup();
    await runner.attach("bot_1", { evaluateImmediately: false });
    await runner.evaluateOnce("bot_1");
    expect(trading.buy).toHaveBeenCalledTimes(1);
    runner.shutdown();
  });

  it("two runners over the same database: only the leader's trades", async () => {
    const a = setup({ held: true });
    const b = setup({ held: false });
    for (const r of [a.runner, b.runner]) {
      await r.reconcile();
      await r.attach("bot_1", { evaluateImmediately: false });
      await r.evaluateOnce("bot_1");
    }
    expect(a.trading.buy).toHaveBeenCalledTimes(1);
    expect(b.trading.buy).not.toHaveBeenCalled();
    a.runner.shutdown();
  });
});
