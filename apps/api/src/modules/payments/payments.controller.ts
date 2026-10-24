import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { getDerivSettings } from "../../lib/config.js";
import { recordAudit } from "../../lib/audit.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { DerivClient } from "../deriv/deriv.client.js";
import type { DerivDeps } from "../deriv/deriv.service.js";
import { agentsQuerySchema, withdrawalOtpRequestSchema, withdrawalRequestSchema } from "./payments.schemas.js";
import { getWithdrawalStatus, listAgents, listHistory, requestWithdrawalOtp, withdraw, type Actor } from "./payments.service.js";

function getDeps(): DerivDeps {
  const settings = getDerivSettings();
  if (!settings) throw new HttpError(503, "DerivNotConfigured", "Deriv integration is not configured on this server");
  return { db: prisma, client: new DerivClient(settings), audit: recordAudit, settings };
}

function actorOf(req: Request): Actor {
  return { userId: req.userId!, label: req.userLabel!, ip: req.ip };
}

// GET /api/payments/deposit-link — a static deep link, nothing else. There is NO deposit API
// (verified: no endpoint exists anywhere in Deriv's current docs — see docs/phase1-architecture.md
// §2/§10); every deposit happens on Deriv's own cashier, outside this app. NOTE: unlike the
// payment-agent endpoints below, this exact URL path is NOT verified against a live Deriv
// session (a headless fetch to it just redirects to the marketing site, same as it would for
// any unauthenticated visitor) — check it against a real logged-in Deriv account before
// relying on it in production.
export async function getDepositLink(_req: Request, res: Response) {
  res.json({ data: { url: "https://app.deriv.com/cashier/deposit" } });
}

export async function getAgents(req: Request, res: Response) {
  const parsed = agentsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new HttpError(400, "ValidationError", "country must be a 2-letter code");
  const deps = getDeps();
  const agents = await listAgents(deps, req.userId!, req.sessionId!, parsed.data.country);
  res.json({ data: agents });
}

export async function postWithdrawalOtp(req: Request, res: Response) {
  const parsed = withdrawalOtpRequestSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "ValidationError", "Invalid withdrawal verification request");
  const deps = getDeps();
  const result = await requestWithdrawalOtp(deps, actorOf(req), req.sessionId!, parsed.data);
  res.json({ data: result });
}

export async function postWithdrawal(req: Request, res: Response) {
  const parsed = withdrawalRequestSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "ValidationError", "Invalid withdrawal request");
  const deps = getDeps();
  const result = await withdraw(deps, actorOf(req), req.sessionId!, parsed.data);
  res.status(201).json({ data: result });
}

export async function getWithdrawalStatusHandler(req: Request, res: Response) {
  const requestId = req.params.requestId;
  if (!requestId) throw new HttpError(400, "ValidationError", "requestId is required");
  const deps = getDeps();
  const result = await getWithdrawalStatus(deps, req.userId!, requestId);
  res.json({ data: result });
}

export async function getHistory(req: Request, res: Response) {
  const history = await listHistory(prisma, req.userId!);
  res.json({ data: history });
}

