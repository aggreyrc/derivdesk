import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { clearSessionCookie, SESSION_COOKIE_NAME, getActiveSession } from "../../lib/session.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { closeSocketsForSession } from "../../ws/socketRegistry.js";

export async function logout(req: Request, res: Response) {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  if (sessionId) {
    await prisma.session.deleteMany({ where: { id: sessionId } });
    closeSocketsForSession(sessionId); // a signed-out browser must not keep a live data stream
  }
  clearSessionCookie(res);
  res.status(204).send();
}

export async function me(req: Request, res: Response) {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  const session = sessionId ? await getActiveSession(sessionId) : null;
  if (!session) {
    throw new HttpError(401, "Unauthorized", "Not signed in");
  }
  // `handle` is the user's Deriv account id: the only identity there is (no email, no password).
  res.json({ data: { id: session.user.id, handle: session.user.handle } });
}
