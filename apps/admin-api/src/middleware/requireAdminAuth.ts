import type { NextFunction, Request, Response } from "express";
import { ADMIN_SESSION_COOKIE_NAME, getActiveAdminSession } from "../lib/session.js";

declare module "express-serve-static-core" {
  interface Request {
    adminId?: string;
    adminEmail?: string;
  }
}

// Express 4 does not catch a rejected promise from an async middleware; an unhandled rejection
// terminates the process on Node >= 15. Forward any failure to the error handler instead.
export function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  authenticateRequest(req, res, next).catch(next);
}

async function authenticateRequest(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.cookies?.[ADMIN_SESSION_COOKIE_NAME];
  if (!sessionId) {
    return res.status(401).json({ error: { code: "Unauthorized", message: "Not signed in" } });
  }

  const session = await getActiveAdminSession(sessionId);
  if (!session) {
    return res.status(401).json({ error: { code: "Unauthorized", message: "Session expired or invalid" } });
  }

  req.adminId = session.adminUserId;
  req.adminEmail = session.adminUser.email;
  next();
}
