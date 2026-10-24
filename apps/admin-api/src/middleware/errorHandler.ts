import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// body-parser (express.json) errors carry `type` and a 4xx `status`; they are the CLIENT's
// fault, so they must not surface as a 500 "InternalError" nor be logged as server errors.
function bodyParserError(err: unknown): { status: number; code: string; message: string } | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { type?: unknown; status?: unknown };
  if (typeof e.type !== "string") return null;
  if (e.type === "entity.too.large") return { status: 413, code: "PayloadTooLarge", message: "Request body is too large" };
  if (e.type.startsWith("entity.") || e.type.startsWith("encoding.") || e.type.startsWith("charset.")) {
    return { status: 400, code: "BadRequest", message: "Malformed request body" };
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }

  const client = bodyParserError(err);
  if (client) {
    return res.status(client.status).json({ error: { code: client.code, message: client.message } });
  }

  // Anything unexpected: log full detail server-side (tagged with the request id so support can
  // match it to what the user saw), tell the client nothing it could use — no stack trace, no DB
  // error text, no internal paths.
  const log = (req as Request & { log?: typeof logger }).log ?? logger;
  log.error({ err, path: req.path, method: req.method }, "unhandled error");
  const requestId = typeof req.id === "string" ? req.id : undefined;
  return res.status(500).json({ error: { code: "InternalError", message: "Something went wrong", ...(requestId ? { requestId } : {}) } });
}
