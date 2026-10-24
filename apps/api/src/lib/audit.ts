import type { Prisma } from "@derivdesk/db";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

export async function recordAudit(entry: {
  actorId: string;
  /** The actor's `users.handle` (a Deriv account id), or "system". Historic column name `actor_email`:
   *  users no longer have an email, and the column is renamed in a later "contract" migration. */
  actorEmail: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Prisma.InputJsonObject;
  ip?: string;
}) {
  await prisma.auditLog.create({
    data: {
      actorType: "CLIENT",
      actorId: entry.actorId,
      actorEmail: entry.actorEmail,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      metadata: entry.metadata,
      ip: entry.ip,
    },
  });
}

/**
 * For audit rows written AFTER money has already moved on Deriv (a buy, a sell, a withdrawal).
 * If the audit insert fails there, failing the HTTP request would tell the user their trade did
 * not happen when it did — worse than a missing row. So the failure is logged loudly with the
 * full entry (so the row can be backfilled from logs) and swallowed.
 */
export async function recordAuditAfterMoneyMoved(entry: Parameters<typeof recordAudit>[0]) {
  try {
    await recordAudit(entry);
  } catch (err) {
    logger.error({ err, auditEntry: entry }, "AUDIT_WRITE_FAILED after a financial action completed — backfill this row");
  }
}
