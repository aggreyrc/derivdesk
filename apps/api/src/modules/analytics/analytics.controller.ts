import type { Request, Response } from "express";
import { z } from "zod";
import type { DerivAccount } from "@derivdesk/db";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { marketDataGateway } from "../market/market.instance.js";
import { computeTechnical } from "./technical.js";
import { getTradingSessionManager } from "../trading/trading.instance.js";
import { getPerformance, getSummary } from "./analytics.service.js";

const querySchema = z.object({ period: z.enum(["7d", "30d", "90d", "all"]).default("30d") });

// Same rule as every other account-scoped endpoint: the account comes from the verified
// session row, never from anything the client sends. Analytics are for the ACTIVE account only
// and say whether it is demo or real, so demo results can't be mistaken for real ones.
async function getActiveAccount(userId: string, sessionId: string): Promise<DerivAccount> {
  const session = await prisma.session.findFirst({ where: { id: sessionId, userId }, include: { activeDerivAccount: true } });
  if (!session?.activeDerivAccount) throw new HttpError(409, "NoActiveAccount", "Select a Deriv account to see its performance");
  if (session.activeDerivAccount.status !== "active") throw new HttpError(409, "AccountUnavailable", "This account is not currently available on Deriv");
  return session.activeDerivAccount;
}

function deps() {
  return { db: prisma, trading: getTradingSessionManager() };
}

export async function getSummaryHandler(req: Request, res: Response) {
  const q = querySchema.safeParse(req.query);
  if (!q.success) throw new HttpError(400, "ValidationError", "period must be 7d, 30d, 90d or all");
  const account = await getActiveAccount(req.userId!, req.sessionId!);
  res.json({ data: await getSummary(deps(), req.userId!, account, q.data.period) });
}

export async function getPerformanceHandler(req: Request, res: Response) {
  const q = querySchema.safeParse(req.query);
  if (!q.success) throw new HttpError(400, "ValidationError", "period must be 7d, 30d, 90d or all");
  const account = await getActiveAccount(req.userId!, req.sessionId!);
  res.json({ data: await getPerformance(deps(), req.userId!, account, q.data.period) });
}

// The same four granularities the Markets chart offers (1m, 5m, 1h, 1d), all valid Deriv candle
// sizes. Market data needs no Deriv account, so unlike the performance endpoints this takes no
// account from the session — only requireAuth (which protects the shared rate-limit budget).
const technicalQuerySchema = z.object({
  symbol: z.string().min(2).max(30).regex(/^[A-Za-z0-9_]+$/),
  granularity: z.coerce.number().int().refine((g) => [60, 300, 3600, 86400].includes(g), "unsupported granularity").default(60),
  count: z.coerce.number().int().min(60).max(1000).default(300),
});

export async function getTechnicalHandler(req: Request, res: Response) {
  const q = technicalQuerySchema.safeParse(req.query);
  if (!q.success) throw new HttpError(400, "ValidationError", "symbol is required; granularity must be 60, 300, 3600 or 86400; count 60-1000");
  const { candles } = await marketDataGateway.getCandles(q.data.symbol, q.data.granularity, q.data.count);
  res.json({ data: { symbol: q.data.symbol, granularity: q.data.granularity, ...computeTechnical(candles) } });
}
