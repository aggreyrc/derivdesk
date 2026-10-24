import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { prisma } from "./prisma.js";
import { config } from "./config.js";

export const SESSION_COOKIE_NAME = "derivdesk_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
// A user can be signed in on a handful of devices; beyond this the OLDEST sessions are revoked
// at login. Bounds table growth and what a leaked-credential attacker can accumulate.
export const MAX_SESSIONS_PER_USER = 10;

export async function createSession(userId: string, ip: string | undefined, userAgent: string | undefined) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await prisma.session.create({
    data: { id: randomUUID(), userId, expiresAt, ip, userAgent },
  });
  await pruneSessions(userId);
  return session;
}

async function pruneSessions(userId: string) {
  // Housekeeping only — a failure here must never block a successful login.
  try {
    await prisma.session.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } });
    const surplus = await prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip: MAX_SESSIONS_PER_USER,
    });
    if (surplus.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: surplus.map((s) => s.id) } } });
    }
  } catch {
    /* ignored on purpose */
  }
}

export function setSessionCookie(res: Response, sessionId: string) {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

export async function getActiveSession(sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date() || session.user.status !== "ACTIVE") {
    return null;
  }
  return session;
}
