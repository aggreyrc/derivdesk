import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@derivdesk/db";
import { createBot, deleteBot, getBot, listCatalog, pauseBot, startBot, stopBot, updateBot } from "../bots.service.js";
import type { BotRunner } from "../botRunner.js";

const validDefinition = {
  candleGranularitySeconds: 60,
  indicators: [{ id: "e", type: "EMA", period: 10 }],
  entryRules: [{ contractType: "CALL", when: { left: { kind: "price", field: "close" }, operator: "GT", right: { kind: "indicator", id: "e" } } }],
  staking: { mode: "FIXED", stake: 1 },
  riskLimits: { stopLossAmount: 10 },
  tradeParams: { durationValue: 5, durationUnit: "t" },
};
const riskParams = { staking: { mode: "FIXED" as const, stake: 1 }, riskLimits: { stopLossAmount: 10 } };
const actor = { userId: "user_1", label: "CR1000001" };

const demo = { id: "acc_demo", userId: "user_1", derivAccountId: "VRTC1", accountType: "DEMO", currency: "USD", status: "active" };
const real = { id: "acc_real", userId: "user_1", derivAccountId: "CR1", accountType: "REAL", currency: "USD", status: "active" };

function bot(overrides: Record<string, unknown> = {}) {
  return { id: "bot_1", userId: "user_1", status: "DRAFT", derivAccount: demo, strategy: { id: "s1" }, ...overrides };
}

function setup(opts: { bot?: unknown; account?: unknown; strategy?: unknown; running?: number; openTrade?: unknown; runner?: BotRunner | null } = {}) {
  const runner = opts.runner === undefined ? ({ attach: vi.fn().mockResolvedValue(undefined), release: vi.fn() } as unknown as BotRunner) : opts.runner;
  const db = {
    botStrategy: { findMany: vi.fn(), findFirst: vi.fn().mockResolvedValue("strategy" in opts ? opts.strategy : { id: "s1", key: "k" }) },
    derivAccount: { findFirst: vi.fn().mockResolvedValue("account" in opts ? opts.account : demo) },
    botInstance: {
      findFirst: vi.fn().mockResolvedValue("bot" in opts ? opts.bot : bot()),
      create: vi.fn().mockResolvedValue({ id: "bot_new" }),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "bot_1", ...data })),
      count: vi.fn().mockResolvedValue(opts.running ?? 0),
      delete: vi.fn().mockResolvedValue({}),
    },
    botTrade: { findFirst: vi.fn().mockResolvedValue(opts.openTrade ?? null), findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient;
  const audit = vi.fn().mockResolvedValue(undefined);
  return { deps: { db, audit, runner: () => runner }, db, audit, runner };
}

const createBody = (accountId: string, confirmReal = false) => ({ strategyId: "s1", accountId, name: "My bot", symbol: "R_100", riskParams, confirmReal });

describe("listCatalog", () => {
  it("shows published strategies and silently drops any whose definition no longer validates", async () => {
    const { deps, db } = setup();
    (db.botStrategy.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "ok", key: "ok", name: "OK", description: "d", definition: validDefinition },
      { id: "bad", key: "bad", name: "Bad", description: "d", definition: { nonsense: true } },
    ]);
    const catalog = await listCatalog(deps);
    expect(catalog.map((c) => c.id)).toEqual(["ok"]);
    expect(catalog[0]).toMatchObject({ indicators: ["EMA"], contractTypes: ["CALL"] });
  });
});

describe("createBot", () => {
  it("only allows a PUBLISHED strategy", async () => {
    const { deps } = setup({ strategy: null });
    await expect(createBot(deps, actor, createBody("acc_demo"))).rejects.toMatchObject({ status: 404 });
  });

  it("refuses an account that isn't the caller's (IDOR)", async () => {
    const { deps, db } = setup({ account: null });
    await expect(createBot(deps, actor, createBody("someone_elses"))).rejects.toMatchObject({ status: 404 });
    expect(db.derivAccount.findFirst).toHaveBeenCalledWith({ where: { id: "someone_elses", userId: "user_1" } });
  });

  it("requires explicit confirmation for a real-money account", async () => {
    const { deps, db } = setup({ account: real });
    await expect(createBot(deps, actor, createBody("acc_real", false))).rejects.toMatchObject({ status: 409, code: "RealAccountConfirmationRequired" });
    expect(db.botInstance.create).not.toHaveBeenCalled();
  });

  it("creates a DRAFT (never auto-started) and audits it", async () => {
    const { deps, db, audit } = setup({ account: real });
    await createBot(deps, actor, createBody("acc_real", true));
    expect(db.botInstance.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "DRAFT", confirmReal: true, userId: "user_1", derivAccountId: "acc_real" }) });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "bots.created" }));
  });
});

describe("ownership scoping", () => {
  it("treats another user's bot as not found", async () => {
    const { deps, db } = setup({ bot: null });
    await expect(getBot(deps, "user_1", "bot_of_someone_else")).rejects.toMatchObject({ status: 404 });
    expect(db.botInstance.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "bot_of_someone_else", userId: "user_1" } }));
  });
});

describe("startBot", () => {
  it("requires fresh real-money confirmation at every start", async () => {
    const { deps, runner } = setup({ bot: bot({ derivAccount: real }) });
    await expect(startBot(deps, actor, "bot_1", false)).rejects.toMatchObject({ status: 409, code: "RealAccountConfirmationRequired" });
    expect((runner as BotRunner).attach).not.toHaveBeenCalled();
  });

  it("caps how many bots one user can run at once", async () => {
    const { deps } = setup({ running: 3 });
    await expect(startBot(deps, actor, "bot_1", false)).rejects.toMatchObject({ status: 409, code: "TooManyRunningBots" });
  });

  it("refuses to start (and doesn't flip status) when the runner is unavailable", async () => {
    const { deps, db } = setup({ runner: null });
    await expect(startBot(deps, actor, "bot_1", false)).rejects.toMatchObject({ status: 503 });
    expect(db.botInstance.update).not.toHaveBeenCalled();
  });

  it("begins a fresh session (reset ladder + P/L) from DRAFT and attaches the runner", async () => {
    const { deps, db, runner } = setup();
    await startBot(deps, actor, "bot_1", false);
    expect(db.botInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "RUNNING", stakingState: { currentStep: 0 }, riskState: { sessionProfitLoss: 0, consecutiveLosses: 0, tradesCount: 0 } }) }),
    );
    expect((runner as BotRunner).attach).toHaveBeenCalledWith("bot_1");
  });

  it("keeps the session state when resuming from PAUSED", async () => {
    const { deps, db } = setup({ bot: bot({ status: "PAUSED" }) });
    await startBot(deps, actor, "bot_1", false);
    const data = (db.botInstance.update as ReturnType<typeof vi.fn>).mock.calls[0]![0].data;
    expect(data.status).toBe("RUNNING");
    expect(data).not.toHaveProperty("stakingState");
    expect(data).not.toHaveProperty("riskState");
  });
});

describe("pause / stop / update / delete", () => {
  it("pause only works on a running bot", async () => {
    const { deps } = setup({ bot: bot({ status: "DRAFT" }) });
    await expect(pauseBot(deps, actor, "bot_1")).rejects.toMatchObject({ status: 409, code: "BotNotRunning" });
  });

  it("stop persists STOPPED first, then releases the runner", async () => {
    const { deps, db, runner } = setup({ bot: bot({ status: "RUNNING" }) });
    await stopBot(deps, actor, "bot_1");
    expect(db.botInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "STOPPED", stopReason: "USER_STOPPED" }) }));
    expect((runner as BotRunner).release).toHaveBeenCalledWith("bot_1");
  });

  it("stop still works when the runner is unavailable", async () => {
    const { deps, db } = setup({ bot: bot({ status: "RUNNING" }), runner: null });
    await expect(stopBot(deps, actor, "bot_1")).resolves.toBeDefined();
    expect(db.botInstance.update).toHaveBeenCalled();
  });

  it("won't edit settings while running", async () => {
    const { deps } = setup({ bot: bot({ status: "RUNNING" }) });
    await expect(updateBot(deps, actor, "bot_1", { name: "x" })).rejects.toMatchObject({ status: 409, code: "BotRunning" });
  });

  it("won't delete a running bot or one with a trade still open", async () => {
    await expect(deleteBot(setup({ bot: bot({ status: "RUNNING" }) }).deps, actor, "bot_1")).rejects.toMatchObject({ code: "BotRunning" });
    await expect(deleteBot(setup({ bot: bot({ status: "STOPPED" }), openTrade: { id: "t" } }).deps, actor, "bot_1")).rejects.toMatchObject({ code: "BotHasOpenTrade" });
  });
});
