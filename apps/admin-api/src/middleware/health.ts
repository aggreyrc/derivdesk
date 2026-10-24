import type { RequestHandler } from "express";

// Readiness for the admin backend: the database must answer. Reports no error detail — it is
// reachable without authentication.
export function createReadyHandler(deps: { pingDatabase: () => Promise<unknown>; timeoutMs?: number }): RequestHandler {
  const timeoutMs = deps.timeoutMs ?? 2000;
  return async (_req, res) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        deps.pingDatabase(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("database ping timed out")), timeoutMs);
        }),
      ]);
      res.json({ status: "ready", database: "ok" });
    } catch {
      res.status(503).json({ status: "not_ready", database: "unreachable" });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
