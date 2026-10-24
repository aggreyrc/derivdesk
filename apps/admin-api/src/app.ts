import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { config } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { standardLimiter, readyLimiter } from "./middleware/rateLimiter.js";
import { createReadyHandler } from "./middleware/health.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { genReqId } from "./middleware/requestId.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { opsRouter } from "./modules/ops/ops.routes.js";
import { botsRouter } from "./modules/bots/bots.routes.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY); // hop count, never `true` — see TRUST_PROXY in lib/config.ts
  app.use(pinoHttp({ logger, genReqId, autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/ready" } })); // first: every request, even rejected ones, gets a correlation id
  app.use(helmet());
  app.use(
    cors({
      origin: config.CORS_ORIGIN, // the admin frontend only — never the client app's origin
      credentials: true,
      exposedHeaders: ["X-Request-Id"],
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: "256kb" })); // strategy definitions are the largest legitimate body (a few KB)

  // Probes sit BEFORE the general limiter: a misconfigured TRUST_PROXY must not be able to throttle
  // the orchestrator's health check into an outage.
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", readyLimiter, createReadyHandler({ pingDatabase: () => prisma.$queryRaw`SELECT 1` }));
  app.use(standardLimiter);

  app.use("/api/admin/auth", authRouter);
  app.use("/api/admin", opsRouter);
  app.use("/api/admin", botsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NotFound", message: "Not found" } });
  });

  app.use(errorHandler);

  return app;
}
