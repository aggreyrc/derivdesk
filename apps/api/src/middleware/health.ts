import type { RequestHandler } from "express";

// Liveness (/health) answers "is the process up". Readiness (/ready) answers "should traffic be
// sent here": the database must answer. It deliberately reports only coarse, non-sensitive facts —
// it is reachable without authentication.

export type RunnerRole = "leader" | "standby" | "disabled";

export interface ReadyDeps {
  /** Resolves if the database answers a trivial query. */
  pingDatabase: () => Promise<unknown>;
  runnerRole: () => RunnerRole;
  timeoutMs?: number;
}

export function createReadyHandler(deps: ReadyDeps): RequestHandler {
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
      res.json({ status: "ready", database: "ok", botRunner: deps.runnerRole() });
    } catch {
      // No error text: it could carry connection details. The cause is in the server log via metrics/alerts.
      res.status(503).json({ status: "not_ready", database: "unreachable", botRunner: deps.runnerRole() });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
