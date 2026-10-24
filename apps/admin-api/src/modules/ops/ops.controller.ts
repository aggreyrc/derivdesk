import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { recordAdminAudit } from "../../lib/audit.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { z } from "zod";

// --- Overview -----------------------------------------------------------
// Phase 2 gives the shape and the two counts we can already get from the DB
// alone; WS-pool stats and API-latency come from the running apps/api
// process in Phase 4+ (out of reach of a DB-only query) and are stubbed
// here rather than faked.
export async function overview(_req: Request, res: Response) {
  const [connectedAccounts, pendingWithdrawals] = await Promise.all([
    prisma.derivAccount.count(),
    prisma.paymentAgentWithdrawal.count({ where: { status: { in: ["REQUESTED", "PENDING"] } } }),
  ]);

  res.json({
    data: {
      connectedAccounts,
      pendingWithdrawals,
      activeWsConnections: null, // wired in Phase 4 once apps/api exposes it
      apiErrorRate: null, // wired once observability (Phase 8) lands
    },
  });
}

// --- Users ----------------------------------------------------------------

export async function listUsers(req: Request, res: Response) {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 25)));

  const [items, total] = await Promise.all([
    prisma.adminVisibleUser.findMany({
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.adminVisibleUser.count(),
  ]);

  res.json({ data: items, meta: { page, pageSize, total } });
}

const setStatusSchema = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) });

export async function setUserStatus(req: Request, res: Response) {
  const parsed = setStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, "ValidationError", "status must be ACTIVE or SUSPENDED");
  }

  const userId = req.params.id;
  if (!userId) {
    throw new HttpError(400, "ValidationError", "user id is required");
  }

  // Goes through the admin_set_user_status() SQL function (see
  // infra/db-init/001_roles.sql), not a direct UPDATE — derivdesk_admin has
  // no UPDATE grant on `users` at all, only EXECUTE on that one function.
  await prisma.$executeRaw`SELECT admin_set_user_status(${userId}, ${parsed.data.status}::"UserStatus")`;

  await recordAdminAudit({
    actorId: req.adminId!,
    actorEmail: req.adminEmail!,
    action: "user.status_changed",
    targetType: "user",
    targetId: userId,
    metadata: { status: parsed.data.status },
    ip: req.ip,
  });

  res.status(204).send();
}

// --- Connection health ------------------------------------------------------
// Balance/status only — never a token. derivdesk_admin has no grant on
// deriv_oauth_tokens at all, so there is nothing here to accidentally leak.

export async function listConnections(_req: Request, res: Response) {
  const accounts = await prisma.derivAccount.findMany({
    select: {
      id: true,
      userId: true,
      derivAccountId: true,
      accountType: true,
      status: true,
      cachedBalance: true,
      cachedBalanceAt: true,
    },
    orderBy: { cachedBalanceAt: "desc" },
    take: 200,
  });
  res.json({ data: accounts });
}

// --- Withdrawals (read-only triage; never initiates one) --------------------

export async function listWithdrawals(req: Request, res: Response) {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const withdrawals = await prisma.paymentAgentWithdrawal.findMany({
    where: status ? { status: status as never } : undefined,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json({ data: withdrawals });
}

// --- Audit log ---------------------------------------------------------------

export async function listAuditLog(req: Request, res: Response) {
  const actorId = typeof req.query.actorId === "string" ? req.query.actorId : undefined;
  const logs = await prisma.auditLog.findMany({
    where: actorId ? { actorId } : undefined,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json({ data: logs });
}

// --- Feature flags -------------------------------------------------------------

export async function listFeatureFlags(_req: Request, res: Response) {
  const flags = await prisma.featureFlag.findMany({ orderBy: { key: "asc" } });
  res.json({ data: flags });
}

const toggleFlagSchema = z.object({ enabled: z.boolean() });

export async function setFeatureFlag(req: Request, res: Response) {
  const parsed = toggleFlagSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, "ValidationError", "enabled must be a boolean");
  }
  const key = req.params.key;
  if (!key) {
    throw new HttpError(400, "ValidationError", "flag key is required");
  }

  const flag = await prisma.featureFlag.upsert({
    where: { key },
    update: { enabled: parsed.data.enabled, updatedBy: req.adminId },
    create: { key, enabled: parsed.data.enabled, updatedBy: req.adminId },
  });

  await recordAdminAudit({
    actorId: req.adminId!,
    actorEmail: req.adminEmail!,
    action: "feature_flag.updated",
    targetType: "feature_flag",
    targetId: key,
    metadata: { enabled: parsed.data.enabled },
    ip: req.ip,
  });

  res.json({ data: flag });
}
