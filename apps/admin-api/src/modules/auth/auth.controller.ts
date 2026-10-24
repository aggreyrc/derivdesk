import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { LoginFailure, authenticateAdmin } from "./auth.service.js";
import { config } from "../../lib/config.js";
import { logger } from "../../lib/logger.js";
import { loginThrottle } from "../../lib/loginThrottle.js";
import { adminLoginSchema } from "./auth.schemas.js";
import {
  createAdminSession,
  setAdminSessionCookie,
  clearAdminSessionCookie,
  ADMIN_SESSION_COOKIE_NAME,
  getActiveAdminSession,
} from "../../lib/session.js";
import { recordAdminAudit } from "../../lib/audit.js";
import { HttpError } from "../../middleware/errorHandler.js";

export async function login(req: Request, res: Response) {
  const parsed = adminLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, "ValidationError", parsed.error.issues[0]?.message ?? "Invalid input");
  }

  const { email, password, totpCode } = parsed.data;
  if (loginThrottle.isBlocked(email, req.ip)) {
    // Refused BEFORE any credential is checked, so a blocked caller learns nothing.
    logger.warn({ event: "admin.login_throttled", ip: req.ip }, "admin login refused: too many recent failures");
    throw new HttpError(429, "TooManyAttempts", "Too many failed sign-in attempts. Try again in a few minutes.");
  }

  let admin;
  try {
    admin = await authenticateAdmin(prisma, email, password, totpCode, { requireTotp: config.ADMIN_REQUIRE_TOTP === "true" });
  } catch (err) {
    if (err instanceof LoginFailure) {
      // Asking for the code is the normal second step of the form, not a failed guess.
      if (err.reason !== "totp_missing") loginThrottle.recordFailure(email, req.ip);
      logger.warn({ event: "admin.login_failed", reason: err.reason, ip: req.ip }, "admin login failed");
      if (err.adminId && err.reason !== "totp_missing") {
        // Failed attempts against a REAL admin account are audited, with the reason.
        await recordAdminAudit({ actorId: err.adminId, actorEmail: email, action: "admin.login_failed", targetType: "admin_user", targetId: err.adminId, metadata: { reason: err.reason }, ip: req.ip }).catch(
          (auditErr: unknown) => logger.error({ err: auditErr }, "could not write admin.login_failed audit row"),
        );
      }
    }
    throw err;
  }
  loginThrottle.recordSuccess(email, req.ip);
  const session = await createAdminSession(admin.id, req.ip, req.get("user-agent") ?? undefined);
  setAdminSessionCookie(res, session.id);

  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  await recordAdminAudit({ actorId: admin.id, actorEmail: admin.email, action: "admin.logged_in", targetType: "admin_user", targetId: admin.id, ip: req.ip });

  res.json({ data: { id: admin.id, email: admin.email } });
}

export async function logout(req: Request, res: Response) {
  const sessionId = req.cookies?.[ADMIN_SESSION_COOKIE_NAME];
  if (sessionId) {
    await prisma.adminSession.deleteMany({ where: { id: sessionId } });
  }
  clearAdminSessionCookie(res);
  res.status(204).send();
}

export async function me(req: Request, res: Response) {
  const sessionId = req.cookies?.[ADMIN_SESSION_COOKIE_NAME];
  const session = sessionId ? await getActiveAdminSession(sessionId) : null;
  if (!session) {
    throw new HttpError(401, "Unauthorized", "Not signed in");
  }
  res.json({ data: { id: session.adminUser.id, email: session.adminUser.email } });
}
