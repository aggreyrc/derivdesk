import type { Prisma } from "@derivdesk/db";
import { prisma } from "./prisma.js";

export async function recordAdminAudit(entry: {
  actorId: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Prisma.InputJsonObject;
  ip?: string;
}) {
  await prisma.auditLog.create({
    data: {
      actorType: "ADMIN",
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
