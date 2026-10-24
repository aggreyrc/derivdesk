// Admin's ENTIRE bot-trading surface: the strategy CATALOG only (templates — name,
// description, indicator/rule/staking definition). This module never touches BotInstance or
// BotTrade — derivdesk_admin has no DB grant on either (see infra/db-init/001_roles.sql) — so
// there is no code path here, even a buggy one, that could see a user's running bot, its
// Deriv account, or its trades. That boundary is enforced at the database layer, not just by
// what this file happens to call.
//
// Same dependency-injection shape as apps/api's payments.service.ts (db/audit passed in, not
// imported directly) so this is unit-testable against a mocked db without a live Postgres —
// see bots.service.test.ts.

import type { PrismaClient } from "@derivdesk/db";
import { Prisma } from "@derivdesk/db";
import { HttpError } from "../../middleware/errorHandler.js";
import type { recordAdminAudit } from "../../lib/audit.js";
import type { CreateStrategyBody, UpdateStrategyBody } from "./bots.schemas.js";

export interface BotsDeps {
  db: PrismaClient;
  audit: typeof recordAdminAudit;
}

export interface Actor {
  adminId: string;
  adminEmail: string;
  ip?: string;
}

function isPrismaKnownError(err: unknown, code: string): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}

const STRATEGY_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

export async function listStrategies(deps: BotsDeps, status?: string) {
  if (status !== undefined && !STRATEGY_STATUSES.includes(status as StrategyStatus)) {
    throw new HttpError(400, "ValidationError", "status must be DRAFT, PUBLISHED, or ARCHIVED");
  }
  return deps.db.botStrategy.findMany({
    where: status ? { status: status as StrategyStatus } : undefined,
    orderBy: { createdAt: "desc" },
  });
}

export async function getStrategy(deps: BotsDeps, id: string) {
  const strategy = await deps.db.botStrategy.findUnique({ where: { id } });
  if (!strategy) throw new HttpError(404, "NotFound", "Strategy not found");
  return strategy;
}

export async function createStrategy(deps: BotsDeps, actor: Actor, body: CreateStrategyBody) {
  let strategy;
  try {
    strategy = await deps.db.botStrategy.create({
      data: {
        key: body.key,
        name: body.name,
        description: body.description,
        definition: body.definition,
        status: "DRAFT", // every new strategy starts as DRAFT — publishing is a separate, explicit step
        createdBy: actor.adminId,
      },
    });
  } catch (err) {
    if (isPrismaKnownError(err, "P2002")) {
      throw new HttpError(409, "StrategyKeyTaken", `A strategy with key "${body.key}" already exists`);
    }
    throw err;
  }

  await deps.audit({
    actorId: actor.adminId,
    actorEmail: actor.adminEmail,
    action: "bot_strategy.created",
    targetType: "bot_strategy",
    targetId: strategy.id,
    metadata: { key: strategy.key, name: strategy.name },
    ip: actor.ip,
  });

  return strategy;
}

export async function updateStrategy(deps: BotsDeps, actor: Actor, id: string, body: UpdateStrategyBody) {
  if (Object.keys(body).length === 0) {
    throw new HttpError(400, "ValidationError", "Provide at least one field to update");
  }

  let strategy;
  try {
    strategy = await deps.db.botStrategy.update({ where: { id }, data: body });
  } catch (err) {
    if (isPrismaKnownError(err, "P2025")) throw new HttpError(404, "NotFound", "Strategy not found");
    throw err;
  }

  await deps.audit({
    actorId: actor.adminId,
    actorEmail: actor.adminEmail,
    action: "bot_strategy.updated",
    targetType: "bot_strategy",
    targetId: strategy.id,
    metadata: { fields: Object.keys(body) },
    ip: actor.ip,
  });

  return strategy;
}

export async function setStrategyStatus(deps: BotsDeps, actor: Actor, id: string, status: StrategyStatus) {
  let strategy;
  try {
    strategy = await deps.db.botStrategy.update({ where: { id }, data: { status } });
  } catch (err) {
    if (isPrismaKnownError(err, "P2025")) throw new HttpError(404, "NotFound", "Strategy not found");
    throw err;
  }

  await deps.audit({
    actorId: actor.adminId,
    actorEmail: actor.adminEmail,
    action: "bot_strategy.status_changed",
    targetType: "bot_strategy",
    targetId: strategy.id,
    metadata: { status },
    ip: actor.ip,
  });

  return strategy;
}

// Hard delete is intentionally narrow: BotStrategy.instances uses onDelete: Restrict (see
// schema.prisma) specifically so a strategy actively in use by a running or historical
// BotInstance can never be deleted out from under it. This exists only to let an admin undo a
// mistaken DRAFT (typo'd key, wrong definition, never published, never used) — not as a
// general "retire a strategy" tool. Use setStrategyStatus(…, "ARCHIVED") for that; archiving
// stops new instances from selecting it while existing ones keep running.
export async function deleteStrategy(deps: BotsDeps, actor: Actor, id: string) {
  try {
    await deps.db.botStrategy.delete({ where: { id } });
  } catch (err) {
    if (isPrismaKnownError(err, "P2025")) throw new HttpError(404, "NotFound", "Strategy not found");
    if (isPrismaKnownError(err, "P2003")) {
      throw new HttpError(409, "StrategyInUse", "This strategy has bot instances using it — archive it instead of deleting it");
    }
    throw err;
  }

  await deps.audit({
    actorId: actor.adminId,
    actorEmail: actor.adminEmail,
    action: "bot_strategy.deleted",
    targetType: "bot_strategy",
    targetId: id,
    ip: actor.ip,
  });
}
