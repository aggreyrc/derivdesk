import type { NextFunction, Request, Response } from "express";
import { SESSION_COOKIE_NAME, getActiveSession } from "../lib/session.js";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
    userLabel?: string;
    sessionId?: string;
  }
}

// Express 4 does not catch a rejected promise from an async middleware. Without this wrapper a
// transient database error here becomes an unhandled rejection, which on Node >= 15 terminates
// the whole process — taking the always-on bot runner and every WebSocket down with it. Any
// failure is forwarded to the error handler instead (a 500 for this one request).
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  authenticateRequest(req, res, next).catch(next);
}

async function authenticateRequest(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  if (!sessionId) {
    return res.status(401).json({ error: { code: "Unauthorized", message: "Not signed in" } });
  }

  const session = await getActiveSession(sessionId);
  if (!session) {
    return res.status(401).json({ error: { code: "Unauthorized", message: "Session expired or invalid" } });
  }

  // Never trust a client-supplied user/account id for anything downstream —
  // every subsequent query in this request scopes by req.userId, derived
  // only from the verified session.
  req.userId = session.userId;
  // `handle` (the Deriv account id) is the user's identity label for audit rows and logs. Users have
  // no email any more: they sign in with Deriv.
  req.userLabel = session.user.handle;
  req.sessionId = session.id;
  next();
}
