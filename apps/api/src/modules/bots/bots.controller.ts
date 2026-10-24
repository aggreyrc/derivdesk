import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { recordAudit } from "../../lib/audit.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { getBotRunner } from "./bots.instance.js";
import { createBotSchema, startBotSchema, tradesQuerySchema, updateBotSchema } from "./bots.schemas.js";
import * as bots from "./bots.service.js";

const deps = (): bots.BotsDeps => ({ db: prisma, audit: recordAudit, runner: getBotRunner });
const actorOf = (req: Request): bots.Actor => ({ userId: req.userId!, label: req.userLabel!, ip: req.ip });
const idOf = (req: Request): string => {
  const id = req.params.id;
  if (!id) throw new HttpError(400, "ValidationError", "bot id is required");
  return id;
};

export async function getCatalog(_req: Request, res: Response) {
  res.json({ data: await bots.listCatalog(deps()) });
}

export async function getBots(req: Request, res: Response) {
  res.json({ data: await bots.listBots(deps(), req.userId!) });
}

export async function getBotById(req: Request, res: Response) {
  res.json({ data: await bots.getBot(deps(), req.userId!, idOf(req)) });
}

export async function getBotTrades(req: Request, res: Response) {
  const parsed = tradesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new HttpError(400, "ValidationError", "limit must be between 1 and 200");
  res.json({ data: await bots.listBotTrades(deps(), req.userId!, idOf(req), parsed.data.limit) });
}

export async function postBot(req: Request, res: Response) {
  const parsed = createBotSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "ValidationError", parsed.error.issues[0]?.message ?? "Invalid bot");
  res.status(201).json({ data: await bots.createBot(deps(), actorOf(req), parsed.data) });
}

export async function patchBot(req: Request, res: Response) {
  const parsed = updateBotSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "ValidationError", parsed.error.issues[0]?.message ?? "Invalid update");
  res.json({ data: await bots.updateBot(deps(), actorOf(req), idOf(req), parsed.data) });
}

export async function postStart(req: Request, res: Response) {
  const parsed = startBotSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new HttpError(400, "ValidationError", "Invalid start request");
  res.json({ data: await bots.startBot(deps(), actorOf(req), idOf(req), parsed.data.confirmReal) });
}

export async function postPause(req: Request, res: Response) {
  res.json({ data: await bots.pauseBot(deps(), actorOf(req), idOf(req)) });
}

export async function postStop(req: Request, res: Response) {
  res.json({ data: await bots.stopBot(deps(), actorOf(req), idOf(req)) });
}

export async function removeBot(req: Request, res: Response) {
  await bots.deleteBot(deps(), actorOf(req), idOf(req));
  res.status(204).send();
}
