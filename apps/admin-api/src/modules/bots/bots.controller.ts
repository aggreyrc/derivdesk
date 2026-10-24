import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { recordAdminAudit } from "../../lib/audit.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { createStrategySchema, setStrategyStatusSchema, updateStrategySchema } from "./bots.schemas.js";
import * as bots from "./bots.service.js";
import type { Actor } from "./bots.service.js";

function deps() {
  return { db: prisma, audit: recordAdminAudit };
}

function actorOf(req: Request): Actor {
  return { adminId: req.adminId!, adminEmail: req.adminEmail!, ip: req.ip };
}

export async function listStrategies(req: Request, res: Response) {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const strategies = await bots.listStrategies(deps(), status);
  res.json({ data: strategies });
}

export async function getStrategy(req: Request, res: Response) {
  const id = req.params.id;
  if (!id) throw new HttpError(400, "ValidationError", "strategy id is required");
  const strategy = await bots.getStrategy(deps(), id);
  res.json({ data: strategy });
}

export async function createStrategy(req: Request, res: Response) {
  const parsed = createStrategySchema.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, "ValidationError", parsed.error.issues[0]?.message ?? "Invalid strategy");
  }
  const strategy = await bots.createStrategy(deps(), actorOf(req), parsed.data);
  res.status(201).json({ data: strategy });
}

export async function updateStrategy(req: Request, res: Response) {
  const id = req.params.id;
  if (!id) throw new HttpError(400, "ValidationError", "strategy id is required");

  const parsed = updateStrategySchema.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, "ValidationError", parsed.error.issues[0]?.message ?? "Invalid update");
  }
  const strategy = await bots.updateStrategy(deps(), actorOf(req), id, parsed.data);
  res.json({ data: strategy });
}

export async function setStrategyStatus(req: Request, res: Response) {
  const id = req.params.id;
  if (!id) throw new HttpError(400, "ValidationError", "strategy id is required");

  const parsed = setStrategyStatusSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "ValidationError", "status must be DRAFT, PUBLISHED, or ARCHIVED");

  const strategy = await bots.setStrategyStatus(deps(), actorOf(req), id, parsed.data.status);
  res.json({ data: strategy });
}

export async function deleteStrategy(req: Request, res: Response) {
  const id = req.params.id;
  if (!id) throw new HttpError(400, "ValidationError", "strategy id is required");
  await bots.deleteStrategy(deps(), actorOf(req), id);
  res.status(204).send();
}
