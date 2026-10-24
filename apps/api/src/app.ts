import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { config } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { httpMetricsMiddleware } from "./lib/metrics.js";
import { standardLimiter, readyLimiter } from "./middleware/rateLimiter.js";
import { createReadyHandler } from "./middleware/health.js";
import { getBotRunnerLease } from "./modules/bots/bots.instance.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { genReqId } from "./middleware/requestId.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { derivRouter } from "./modules/deriv/deriv.routes.js";
import { marketRouter } from "./modules/market/market.routes.js";
import { tradingRouter } from "./modules/trading/trading.routes.js";
import { analyticsRouter } from "./modules/analytics/analytics.routes.js";
import { botsRouter } from "./modules/bots/bots.routes.js";
import { paymentsRouter } from "./modules/payments/payments.routes.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  // Hop count, never `true`: see TRUST_PROXY in lib/config.ts. Without this behind a load balancer
  // every client shares the proxy's IP (one rate-limit bucket for everyone), and with a blanket
  // `true` any client could pick its own IP via X-Forwarded-For.
  app.set("trust proxy", config.TRUST_PROXY);
  // First, so rate-limited and rejected requests still get a correlation id in the logs.
  // Probes fire every few seconds from every instance; logging each one buries real traffic.
  app.use(pinoHttp({ logger, genReqId, autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/ready" } }));
  app.use(helmet());
  app.use(
    cors({
      origin: config.CORS_ORIGIN,
      credentials: true, // required for the session cookie
      exposedHeaders: ["X-Request-Id"],
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: "100kb" })); // largest legitimate body is a bot strategy/config (a few KB)
  app.use(httpMetricsMiddleware);

  // Probes sit BEFORE the general rate limiter on purpose: if TRUST_PROXY is ever misconfigured the
  // limiter sees one shared IP for everybody, and a limiter that can throttle the load balancer's
  // health check turns a config mistake into an outage. /ready has its own small limiter.
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get(
    "/ready",
    readyLimiter,
    createReadyHandler({
      pingDatabase: () => prisma.$queryRaw`SELECT 1`,
      runnerRole: () => (config.BOT_RUNNER_ENABLED !== "true" ? "disabled" : getBotRunnerLease()?.isHeld() ? "leader" : "standby"),
    }),
  );
  app.use(standardLimiter);

  app.use("/api/auth", authRouter);
  app.use("/api/deriv", derivRouter);
  app.use("/api/markets", marketRouter);
  app.use("/api/trading", tradingRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/bots", botsRouter);
  app.use("/api/analytics", analyticsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NotFound", message: "Not found" } });
  });

  app.use(errorHandler);

  return app;
}
