import type { Request, Response } from "express";
import { z } from "zod";
import type { DerivAccount } from "@derivdesk/db";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { recordAuditAfterMoneyMoved } from "../../lib/audit.js";
import { buyGuard } from "./buyGuard.js";
import { marketDataGateway } from "../market/market.instance.js";
import { getTradingSessionManager } from "./trading.instance.js";
import { buyRequestSchema, profitTableQuerySchema, proposalBodySchema, sellRequestSchema } from "./trading.schemas.js";

/**
 * Resolves the session's active Deriv account straight from the verified session row —
 * NEVER from anything the client supplies in the request body, query string or any other
 * part of this request. A trade can only ever be placed against the account the user
 * explicitly activated (deriv.service.ts's activateAccount), and a REAL account only ever
 * became active because of an explicit confirmation there — never a silent default.
 */
async function getActiveAccount(userId: string, sessionId: string): Promise<DerivAccount> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
    include: { activeDerivAccount: true },
  });
  if (!session?.activeDerivAccount) {
    throw new HttpError(409, "NoActiveAccount", "Select a Deriv account before trading");
  }
  if (session.activeDerivAccount.status !== "active") {
    throw new HttpError(409, "AccountUnavailable", "This account is not currently available on Deriv");
  }
  return session.activeDerivAccount;
}

// POST /api/trading/proposal — a price quote. No money moves here; this is Deriv's
// no-auth `proposal` call (see market.gateway.ts), routed through the trading module
// because it's step one of a trade. `currency` is intentionally never read from the
// request body — see trading.schemas.ts's comment on proposalBodySchema.
export async function postProposal(req: Request, res: Response) {
  const parsed = proposalBodySchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "ValidationError", "Invalid proposal request");
  const account = await getActiveAccount(req.userId!, req.sessionId!);

  const proposal = await marketDataGateway.getProposal({
    contract_type: parsed.data.contractType,
    underlying_symbol: parsed.data.symbol,
    currency: account.currency,
    amount: parsed.data.amount,
    basis: parsed.data.basis,
    duration: parsed.data.duration,
    duration_unit: parsed.data.durationUnit,
    barrier: parsed.data.barrier,
    barrier2: parsed.data.barrier2,
    multiplier: parsed.data.multiplier,
  });

  res.json({ data: proposal });
}

const realConfirmSchema = z.object({ confirmReal: z.literal(true) });

// POST /api/trading/buy — the only place real money actually moves in Phase 5. `priceAgreed`
// re-states the proposal's ask_price back to Deriv, which is how Deriv itself guards against
// the price having moved since the quote (see developers.deriv.com/comparison/buy/) — we
// never invent or adjust this value ourselves.
export async function postBuy(req: Request, res: Response) {
  const parsed = buyRequestSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "ValidationError", "Invalid buy request");
  const account = await getActiveAccount(req.userId!, req.sessionId!);

  if (account.accountType === "REAL" && !realConfirmSchema.safeParse(req.body).success) {
    throw new HttpError(409, "RealAccountConfirmationRequired", "Buying on a real-money account requires explicit confirmation");
  }

  const manager = getTradingSessionManager();
  buyGuard.begin(req.userId!, parsed.data.proposalId);
  let result: Awaited<ReturnType<typeof manager.buy>>;
  try {
    result = await manager.buy(req.userId!, account.derivAccountId, parsed.data.proposalId, parsed.data.priceAgreed);
  } catch (err) {
    // A thrown error does not prove the purchase failed (e.g. a timeout after Deriv accepted it),
    // but it also did not return a contract id; leaving the quote reusable is the lesser harm —
    // the in-flight lock is released and the user is pointed at their portfolio in the UI.
    buyGuard.finish(req.userId!, parsed.data.proposalId, "failed");
    throw err;
  }
  buyGuard.finish(req.userId!, parsed.data.proposalId, "bought");

  // Best-effort local cache for cross-session "my open positions" convenience — Deriv's own
  // `portfolio`/`proposal_open_contract` responses remain the authoritative truth; this row
  // is never read as the source of what the user actually holds.
  await prisma.localTrade
    .upsert({
      where: { derivAccountId_contractId: { derivAccountId: account.id, contractId: String(result.contract_id) } },
      create: {
        userId: req.userId!,
        derivAccountId: account.id,
        contractId: String(result.contract_id),
        transactionId: String(result.transaction_id),
        contractType: parsed.data.contractType,
        underlyingSymbol: parsed.data.underlyingSymbol,
        buyPrice: String(result.buy_price),
        payout: result.payout !== undefined ? String(result.payout) : null,
        purchaseTime: new Date(result.purchase_time * 1000),
        status: "OPEN",
      },
      update: { status: "OPEN", lastSyncedAt: new Date() },
    })
    .catch((err: unknown) => {
      // The buy already succeeded on Deriv — never fail the request over our own cache write.
      logger.warn({ err }, "failed to upsert local_trades row after a successful buy");
    });

  await recordAuditAfterMoneyMoved({
    actorId: req.userId!,
    actorEmail: req.userLabel!,
    action: "trading.buy",
    targetType: "local_trade",
    targetId: String(result.contract_id),
    metadata: { derivAccountId: account.derivAccountId, accountType: account.accountType, contractType: parsed.data.contractType, underlyingSymbol: parsed.data.underlyingSymbol },
    ip: req.ip,
  });

  res.status(201).json({ data: result });
}

// POST /api/trading/sell — closes a contract early. `minPrice` (default 0) is Deriv's own
// slippage guard, same as `priceAgreed` on buy.
export async function postSell(req: Request, res: Response) {
  const parsed = sellRequestSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "ValidationError", "Invalid sell request");
  const account = await getActiveAccount(req.userId!, req.sessionId!);

  const manager = getTradingSessionManager();
  const result = await manager.sell(req.userId!, account.derivAccountId, parsed.data.contractId, parsed.data.minPrice);

  await prisma.localTrade
    .updateMany({
      where: { derivAccountId: account.id, contractId: String(parsed.data.contractId) },
      data: { status: "SOLD", lastSyncedAt: new Date() },
    })
    .catch((err: unknown) => {
      logger.warn({ err }, "failed to update local_trades row after a successful sell");
    });

  await recordAuditAfterMoneyMoved({
    actorId: req.userId!,
    actorEmail: req.userLabel!,
    action: "trading.sell",
    targetType: "local_trade",
    targetId: String(result.contract_id),
    metadata: { derivAccountId: account.derivAccountId },
    ip: req.ip,
  });

  res.json({ data: result });
}

// GET /api/trading/portfolio — live open positions, read straight from Deriv (authoritative).
export async function getPortfolio(req: Request, res: Response) {
  const account = await getActiveAccount(req.userId!, req.sessionId!);
  const manager = getTradingSessionManager();
  const contracts = await manager.getPortfolio(req.userId!, account.derivAccountId);
  res.json({ data: contracts });
}

// GET /api/trading/history — closed trades with realized P/L, read straight from Deriv's
// `profit_table` (authoritative) — never computed or estimated from our own local_trades cache.
export async function getHistory(req: Request, res: Response) {
  const parsedQuery = profitTableQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) throw new HttpError(400, "ValidationError", "limit must be a positive number, at most 200");
  const account = await getActiveAccount(req.userId!, req.sessionId!);
  const manager = getTradingSessionManager();
  const transactions = await manager.getProfitTable(req.userId!, account.derivAccountId, parsedQuery.data.limit);
  res.json({ data: transactions });
}
