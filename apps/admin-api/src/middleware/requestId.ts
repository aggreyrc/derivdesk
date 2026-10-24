import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// Correlation id for every request (spec §25): taken from an inbound X-Request-Id only when it is
// a short, boring token — an attacker-controlled value must never be able to inject log lines or
// headers — otherwise freshly generated. Echoed back so a user can quote it to support.
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function genReqId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers["x-request-id"];
  const id = typeof incoming === "string" && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", id);
  return id;
}
