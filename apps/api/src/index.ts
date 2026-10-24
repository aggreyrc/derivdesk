import { createServer } from "node:http";
import { createApp } from "./app.js";
import { config } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { attachWsGateway } from "./ws/wsGateway.js";
import { countAllSockets } from "./ws/socketRegistry.js";
import { startMetricsServer } from "./lib/metricsServer.js";
import { marketDataGateway } from "./modules/market/market.instance.js";
import { getBotRunner, getBotRunnerLease, startBotRunnerWithLease } from "./modules/bots/bots.instance.js";

const app = createApp();
const httpServer = createServer(app);
attachWsGateway(httpServer, config.CORS_ORIGIN);

marketDataGateway.start();
marketDataGateway.on("status", (status) => logger.info({ status }, "Deriv public market-data connection status"));

if (config.BOT_RUNNER_ENABLED === "true") {
  if (getBotRunner()) {
    // Eligible to run bots, not guaranteed to: only the process holding the database lease does.
    startBotRunnerWithLease(config.BOT_RUNNER_LEASE_TTL_MS);
  } else {
    logger.warn("Deriv is not configured — bot runner not started");
  }
} else {
  logger.warn("BOT_RUNNER_ENABLED=false — bot runner not started");
}

if (config.METRICS_PORT) {
  startMetricsServer(config.METRICS_PORT, {
    wsConnections: countAllSockets,
    botRunnerIsLeader: () => getBotRunnerLease()?.isHeld() ?? false,
    botsAttached: () => getBotRunner()?.attachedCount() ?? 0,
    derivMarketConnected: () => marketDataGateway.getStatus() === "open",
  });
  logger.info({ port: config.METRICS_PORT }, "metrics listener up (internal network only)");
}

httpServer.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "apps/api listening (HTTP + WS on the same port)");
});

function shutdown() {
  logger.info("shutting down");
  setTimeout(() => process.exit(1), 8000).unref(); // don't hang forever on a stuck connection
  // Stop trading and free the lease first so a standby can take over immediately.
  void (getBotRunnerLease()?.stop() ?? Promise.resolve()).finally(() => {
    getBotRunner()?.shutdown();
    marketDataGateway.stop();
    httpServer.close(() => process.exit(0));
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
