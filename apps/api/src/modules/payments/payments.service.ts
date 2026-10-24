import { randomUUID } from "node:crypto";
import type { PrismaClient, WithdrawalStatus } from "@derivdesk/db";
import { HttpError } from "../../middleware/errorHandler.js";
import { logger } from "../../lib/logger.js";
import type { recordAudit } from "../../lib/audit.js";
import { DerivApiError, type DerivClientLike, type DerivWithdrawalStatus } from "../deriv/deriv.client.js";
import { getValidAccessToken, type DerivDeps } from "../deriv/deriv.service.js";

export interface PaymentsDeps extends DerivDeps {}

export interface Actor {
  userId: string;
  label: string;
  ip?: string;
}

// Deriv's own status strings (lowercase) vs. our Prisma enum (uppercase) — kept as two
// distinct vocabularies on purpose rather than changing the schema enum to match Deriv's
// casing, since a future Deriv status addition shouldn't silently become a valid Prisma enum
// value without a deliberate migration.
const STATUS_FROM_DERIV: Record<DerivWithdrawalStatus, WithdrawalStatus> = {
  requested: "REQUESTED",
  pending: "PENDING",
  complete: "COMPLETE",
  rejected: "REJECTED",
  failed: "FAILED",
};

/** Resolves the session's active Deriv account from the verified session row — never from
 *  anything the client supplies. Withdrawals only make sense against a REAL account (Deriv's
 *  payment-agent network doesn't operate on demo balances), so this also rejects a demo
 *  account outright rather than letting Deriv reject it less clearly downstream. */
async function getActiveRealAccount(db: PrismaClient, userId: string, sessionId: string) {
  const session = await db.session.findFirst({ where: { id: sessionId, userId }, include: { activeDerivAccount: true } });
  const account = session?.activeDerivAccount;
  if (!account) throw new HttpError(409, "NoActiveAccount", "Select a Deriv account before withdrawing");
  if (account.status !== "active") throw new HttpError(409, "AccountUnavailable", "This account is not currently available on Deriv");
  if (account.accountType !== "REAL") throw new HttpError(409, "RealAccountRequired", "Withdrawals are only available on a real-money account");
  return account;
}

export async function listAgents(deps: PaymentsDeps, userId: string, sessionId: string, country?: string) {
  const account = await getActiveRealAccount(deps.db, userId, sessionId);
  const token = await getValidAccessToken(deps, userId);
  return deps.client.listPaymentAgents(token, account.currency, country);
}

export async function requestWithdrawalOtp(deps: PaymentsDeps, actor: Actor, sessionId: string, input: { agentId: number; amount: number }) {
  const account = await getActiveRealAccount(deps.db, actor.userId, sessionId);
  const token = await getValidAccessToken(deps, actor.userId);
  const otp = await deps.client.requestWithdrawalOtp(token, {
    agentId: input.agentId,
    amount: input.amount.toFixed(2),
    currency: account.currency,
  });
  await deps.audit({
    actorId: actor.userId,
    actorEmail: actor.label,
    action: "payments.withdrawal_otp_requested",
    targetType: "deriv_account",
    targetId: account.id,
    metadata: { agentId: input.agentId },
    ip: actor.ip,
  });
  return { expiresAt: otp.expires_at, nextRequestAt: otp.next_request_at };
}

export async function withdraw(
  deps: PaymentsDeps,
  actor: Actor,
  sessionId: string,
  input: { agentId: number; amount: number; verificationCode: string; notes?: string },
) {
  const account = await getActiveRealAccount(deps.db, actor.userId, sessionId);
  const token = await getValidAccessToken(deps, actor.userId);
  const requestId = randomUUID();
  const amountStr = input.amount.toFixed(2);

  // Our local row is written BEFORE calling Deriv, as REQUESTED — so a withdrawal that Deriv
  // accepted but whose response we failed to receive (timeout, our process crashing) is still
  // visible to the user and support as "requested", not silently lost. If the call itself
  // fails outright (never reached Deriv, or Deriv rejected it), the row is deleted again —
  // there's nothing requested to show.
  await deps.db.paymentAgentWithdrawal.create({
    data: {
      userId: actor.userId,
      derivAccountId: account.id,
      agentId: String(input.agentId),
      amount: amountStr,
      currency: account.currency,
      requestId,
      status: "REQUESTED",
    },
  });

  let result: Awaited<ReturnType<DerivClientLike["withdrawViaPaymentAgent"]>>;
  try {
    result = await deps.client.withdrawViaPaymentAgent(token, {
      agentId: input.agentId,
      amount: amountStr,
      currency: account.currency,
      verificationCode: input.verificationCode,
      requestId,
      notes: input.notes,
    });
  } catch (err) {
    // Only a DEFINITIVE rejection (Deriv answered with a 4xx) proves nothing was requested and
    // lets us drop the local row. A timeout, a 5xx, or a 2xx we could not parse proves nothing:
    // Deriv may well have accepted the withdrawal. In that case the REQUESTED row is kept so the
    // money is never invisible, and getWithdrawalStatus() resolves it from Deriv by request_id.
    const definitive = err instanceof DerivApiError && err.status >= 400 && err.status < 500;
    if (definitive) {
      await deps.db.paymentAgentWithdrawal.delete({ where: { requestId } }).catch(() => undefined);
    }
    await auditAfterMoneyMoved(deps, {
      actorId: actor.userId,
      actorEmail: actor.label,
      action: definitive ? "payments.withdrawal_failed" : "payments.withdrawal_outcome_unknown",
      targetType: definitive ? "deriv_account" : "payment_agent_withdrawal",
      targetId: definitive ? account.id : requestId,
      metadata: { agentId: input.agentId, reason: err instanceof DerivApiError ? err.code : "unknown", ...(definitive ? {} : { requestId }) },
      ip: actor.ip,
    });
    if (definitive) {
      // Surface Deriv's own rejection reason (invalid code, limits, rate limit) — never
      // reworded into something vaguer, the person needs to know what to fix.
      throw new HttpError(422, (err as DerivApiError).code, "Deriv rejected the withdrawal request");
    }
    throw new HttpError(
      502,
      "WithdrawalOutcomeUnknown",
      `We could not confirm whether Deriv accepted this withdrawal. Do NOT submit it again — check its status under request ${requestId} in your withdrawal history and on Deriv.`,
    );
  }

  // Money has now been requested. Nothing below may turn this into a reported failure.
  const updated = await deps.db.paymentAgentWithdrawal.update({
    where: { requestId },
    data: { status: STATUS_FROM_DERIV[result.status] },
  });
  await auditAfterMoneyMoved(deps, {
    actorId: actor.userId,
    actorEmail: actor.label,
    action: "payments.withdrawal_submitted",
    targetType: "payment_agent_withdrawal",
    targetId: updated.id,
    metadata: { agentId: input.agentId, amount: amountStr, currency: account.currency, status: result.status },
    ip: actor.ip,
  });
  return updated;
}

/** Audit write after a financial action completed: a failure is logged with the full entry for
 *  backfill instead of failing a request whose money movement already happened. */
async function auditAfterMoneyMoved(deps: PaymentsDeps, entry: Parameters<PaymentsDeps["audit"]>[0]) {
  try {
    await deps.audit(entry);
  } catch (err) {
    logger.error({ err, auditEntry: entry }, "AUDIT_WRITE_FAILED after a financial action — backfill this row");
  }
}

export async function getWithdrawalStatus(deps: PaymentsDeps, userId: string, requestId: string) {
  // Scoped by userId — a request_id belonging to someone else is indistinguishable from one
  // that doesn't exist, same IDOR-prevention rule as everywhere else in this app.
  const row = await deps.db.paymentAgentWithdrawal.findFirst({ where: { requestId, userId } });
  if (!row) throw new HttpError(404, "NotFound", "Withdrawal not found");

  if (row.status === "COMPLETE" || row.status === "REJECTED" || row.status === "FAILED") {
    return row; // settled — Deriv won't have anything new to tell us
  }

  const token = await getValidAccessToken(deps, userId);
  try {
    const fresh = await deps.client.getWithdrawalStatus(token, requestId);
    const mapped = STATUS_FROM_DERIV[fresh.status];
    if (mapped === row.status) return row;
    return deps.db.paymentAgentWithdrawal.update({ where: { requestId }, data: { status: mapped } });
  } catch {
    return row; // best-effort refresh — show the last known status rather than fail the page
  }
}

export async function listHistory(db: PrismaClient, userId: string) {
  return db.paymentAgentWithdrawal.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}
