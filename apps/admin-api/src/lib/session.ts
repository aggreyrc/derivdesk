import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { prisma } from "./prisma.js";
import { config } from "./config.js";

export const ADMIN_SESSION_COOKIE_NAME = "derivdesk_admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours — shorter than the client app's, deliberately
const MAX_SESSIONS_PER_ADMIN = 3; // oldest are revoked at login

export async function createAdminSession(adminUserId: string, ip: string | undefined, userAgent: string | undefined) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await prisma.adminSession.create({
    data: { id: randomUUID(), adminUserId, expiresAt, ip, userAgent },
  });
  try {
    // Housekeeping only — must never block a successful sign-in.
    await prisma.adminSession.deleteMany({ where: { adminUserId, expiresAt: { lt: new Date() } } });
    const surplus = await prisma.adminSession.findMany({ where: { adminUserId }, orderBy: { createdAt: "desc" }, skip: MAX_SESSIONS_PER_ADMIN });
    if (surplus.length > 0) await prisma.adminSession.deleteMany({ where: { id: { in: surplus.map((s) => s.id) } } });
  } catch {
    /* ignored on purpose */
  }
  return session;
}

export function setAdminSessionCookie(res: Response, sessionId: string) {
  res.cookie(ADMIN_SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearAdminSessionCookie(res: Response) {
  res.clearCookie(ADMIN_SESSION_COOKIE_NAME, { path: "/" });
}

export async function getActiveAdminSession(sessionId: string) {
  const session = await prisma.adminSession.findUnique({
    where: { id: sessionId },
    include: { adminUser: true },
  });
  if (!session || session.expiresAt < new Date() || session.adminUser.status !== "ACTIVE") {
    return null;
  }
  return session;
}
