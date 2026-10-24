// User-facing bot management. Everything here is scoped to the signed-in user: every read and
// write includes userId in its query, so another user's bot, account or trades is "not found",
// never "forbidden" (no IDOR, no existence leak). Admin has no equivalent — see admin-api's
// bots module, which only ever touches the strategy catalog.

import type { BotInstance, BotStrategy, DerivAccount, PrismaClient } from "@derivdesk/db";
import { HttpError } from "../../middleware/errorHandler.js";
import type { recordAudit } from "../../lib/audit.js";
import type { BotRunner } from "./botRunner.js";
import { strategyDefinitionSchema } from "./strategy.schema.js";
import type { CreateBotBody, UpdateBotBody } from "./bots.schemas.js";
import { INITIAL_RISK_STATE, INITIAL_STAKING_STATE } from "./staking.js";

export const MAX_RUNNING_BOTS_PER_USER = 3;

export interface BotsDeps {
  db: PrismaClient;
  audit: typeof recordAudit;
  runner: () => BotRunner | null;
}
export interface Actor {
  userId: string;
  label: string;
  ip?: string;
}

/** Published strategies only, with the template's suggested staking/risk values so the UI can
 *  prefill — suggestions only; the user's own riskParams are what actually run. */
export async function listCatalog(deps: BotsDeps) {
  const rows = await deps.db.botStrategy.findMany({ where: { status: "PUBLISHED" }, orderBy: { createdAt: "desc" } });
  return rows.flatMap((row) => {
    const def = strategyDefinitionSchema.safeParse(row.definition);
    if (!def.success) return []; // never show a strategy whose definition no longer validates
    return [
      {
        id: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
        candleGranularitySeconds: def.data.candleGranularitySeconds,
        indicators: def.data.indicators.map((i) => i.type),
        contractTypes: [...new Set(def.data.entryRules.map((r) => r.contractType))],
        tradeParams: def.data.tradeParams,
        suggested: { staking: def.data.staking, riskLimits: def.data.riskLimits },
      },
    ];
  });
}

export async function listBots(deps: BotsDeps, userId: string) {
  return deps.db.botInstance.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, include: { strategy: true, derivAccount: true } });
}

type OwnedBot = BotInstance & { strategy: BotStrategy; derivAccount: DerivAccount };

async function getOwnedBot(deps: BotsDeps, userId: string, id: string): Promise<OwnedBot> {
  const bot = await deps.db.botInstance.findFirst({ where: { id, userId }, include: { strategy: true, derivAccount: true } });
  if (!bot) throw new HttpError(404, "NotFound", "Bot not found");
  return bot as OwnedBot;
}

export async function getBot(deps: BotsDeps, userId: string, id: string) {
  return getOwnedBot(deps, userId, id);
}

export async function listBotTrades(deps: BotsDeps, userId: string, id: string, limit: number) {
  await getOwnedBot(deps, userId, id); // ownership check first
  return deps.db.botTrade.findMany({ where: { botInstanceId: id }, orderBy: { placedAt: "desc" }, take: limit });
}

export async function createBot(deps: BotsDeps, actor: Actor, body: CreateBotBody) {
  const strategy = await deps.db.botStrategy.findFirst({ where: { id: body.strategyId, status: "PUBLISHED" } });
  if (!strategy) throw new HttpError(404, "NotFound", "Strategy not found");

  const account = await deps.db.derivAccount.findFirst({ where: { id: body.accountId, userId: actor.userId } });
  if (!account) throw new HttpError(404, "NotFound", "Account not found");
  if (account.status !== "active") throw new HttpError(409, "AccountUnavailable", "This account is not currently available on Deriv");
  if (account.accountType === "REAL" && body.confirmReal !== true) {
    throw new HttpError(409, "RealAccountConfirmationRequired", "A bot on a real-money account requires explicit confirmation");
  }

  const bot = await deps.db.botInstance.create({
    data: {
      userId: actor.userId,
      derivAccountId: account.id,
      strategyId: strategy.id,
      name: body.name,
      symbol: body.symbol,
      riskParams: body.riskParams,
      confirmReal: account.accountType === "REAL",
      status: "DRAFT",
    },
  });
  await deps.audit({
    actorId: actor.userId,
    actorEmail: actor.label,
    action: "bots.created",
    targetType: "bot_instance",
    targetId: bot.id,
    metadata: { strategyKey: strategy.key, accountType: account.accountType, derivAccountId: account.derivAccountId, symbol: body.symbol },
    ip: actor.ip,
  });
  return bot;
}

export async function updateBot(deps: BotsDeps, actor: Actor, id: string, body: UpdateBotBody) {
  const bot = await getOwnedBot(deps, actor.userId, id);
  if (bot.status === "RUNNING") throw new HttpError(409, "BotRunning", "Pause or stop the bot before changing its settings");
  const updated = await deps.db.botInstance.update({ where: { id: bot.id }, data: body });
  await deps.audit({ actorId: actor.userId, actorEmail: actor.label, action: "bots.updated", targetType: "bot_instance", targetId: bot.id, metadata: { fields: Object.keys(body) }, ip: actor.ip });
  return updated;
}

export async function startBot(deps: BotsDeps, actor: Actor, id: string, confirmReal: boolean) {
  const bot = await getOwnedBot(deps, actor.userId, id);
  if (bot.status === "RUNNING") return bot; // idempotent

  const account = bot.derivAccount;
  if (account.status !== "active") throw new HttpError(409, "AccountUnavailable", "This account is not currently available on Deriv");
  // Real money is confirmed again at EVERY start, not just at creation.
  if (account.accountType === "REAL" && !confirmReal) {
    throw new HttpError(409, "RealAccountConfirmationRequired", "Starting a bot on a real-money account requires explicit confirmation");
  }

  const runningCount = await deps.db.botInstance.count({ where: { userId: actor.userId, status: "RUNNING" } });
  if (runningCount >= MAX_RUNNING_BOTS_PER_USER) {
    throw new HttpError(409, "TooManyRunningBots", `You can run at most ${MAX_RUNNING_BOTS_PER_USER} bots at once`);
  }

  const runner = deps.runner();
  if (!runner) throw new HttpError(503, "BotRunnerUnavailable", "Bots can't run right now — Deriv isn't configured on this server");

  // Resuming a pause continues the same session; any other start begins a fresh one.
  const fresh = bot.status !== "PAUSED";
  const updated = await deps.db.botInstance.update({
    where: { id: bot.id },
    data: {
      status: "RUNNING",
      stopReason: null,
      lastError: null,
      stoppedAt: null,
      startedAt: new Date(),
      ...(fresh ? { stakingState: { ...INITIAL_STAKING_STATE }, riskState: { ...INITIAL_RISK_STATE } } : {}),
    },
  });
  await runner.attach(bot.id);
  await deps.audit({
    actorId: actor.userId,
    actorEmail: actor.label,
    action: "bots.started",
    targetType: "bot_instance",
    targetId: bot.id,
    metadata: { accountType: account.accountType, derivAccountId: account.derivAccountId, resumed: !fresh },
    ip: actor.ip,
  });
  return updated;
}

async function halt(deps: BotsDeps, actor: Actor, id: string, status: "PAUSED" | "STOPPED", action: string) {
  const bot = await getOwnedBot(deps, actor.userId, id);
  if (bot.status === status) return bot;
  if (status === "PAUSED" && bot.status !== "RUNNING") throw new HttpError(409, "BotNotRunning", "Only a running bot can be paused");

  const updated = await deps.db.botInstance.update({
    where: { id: bot.id },
    data: { status, stoppedAt: new Date(), ...(status === "STOPPED" ? { stopReason: "USER_STOPPED" } : {}) },
  });
  // Status is already persisted, so even if the runner is unavailable the bot will not trade
  // again: the runner re-checks status on every cycle and on restart only resumes RUNNING bots.
  deps.runner()?.release(bot.id);
  await deps.audit({ actorId: actor.userId, actorEmail: actor.label, action, targetType: "bot_instance", targetId: bot.id, ip: actor.ip });
  return updated;
}

export const pauseBot = (deps: BotsDeps, actor: Actor, id: string) => halt(deps, actor, id, "PAUSED", "bots.paused");
export const stopBot = (deps: BotsDeps, actor: Actor, id: string) => halt(deps, actor, id, "STOPPED", "bots.stopped_by_user");

export async function deleteBot(deps: BotsDeps, actor: Actor, id: string) {
  const bot = await getOwnedBot(deps, actor.userId, id);
  if (bot.status === "RUNNING") throw new HttpError(409, "BotRunning", "Stop the bot before deleting it");
  const openTrade = await deps.db.botTrade.findFirst({ where: { botInstanceId: bot.id, status: "OPEN" } });
  if (openTrade) throw new HttpError(409, "BotHasOpenTrade", "This bot still has a trade open on Deriv — wait for it to settle before deleting");
  await deps.db.botInstance.delete({ where: { id: bot.id } });
  await deps.audit({ actorId: actor.userId, actorEmail: actor.label, action: "bots.deleted", targetType: "bot_instance", targetId: bot.id, ip: actor.ip });
}
