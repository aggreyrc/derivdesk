import { prisma } from "../../lib/prisma.js";
import { recordAudit } from "../../lib/audit.js";
import { getDerivSettings } from "../../lib/config.js";
import { marketDataGateway } from "../market/market.instance.js";
import { getTradingSessionManager } from "../trading/trading.instance.js";
import { BotRunner } from "./botRunner.js";
import { PgLeaseStore, RunnerLease } from "../../lib/runnerLease.js";

// One runner for the whole process. Built lazily because it needs Deriv settings (same
// tolerance as trading.instance.ts) — returns null when Deriv isn't configured, in which case
// bots simply can't run.
let instance: BotRunner | null = null;

export function getBotRunner(): BotRunner | null {
  if (!getDerivSettings()) return null;
  if (!instance) {
    instance = new BotRunner({
      db: prisma,
      market: marketDataGateway,
      trading: getTradingSessionManager(),
      audit: recordAudit,
      // Fail closed: with no lease (BOT_RUNNER_ENABLED=false, tooling) nothing ever attaches or trades.
      canTrade: () => (lease ? lease.isHeld() : false),
    });
  }
  return instance;
}

export const BOT_RUNNER_LEASE_NAME = "bot-runner";

let lease: RunnerLease | null = null;

/** The leader lease for this process (null until startBotRunnerWithLease runs). */
export function getBotRunnerLease(): RunnerLease | null {
  return lease;
}

/** Starts competing for the bot-runner lease. Only the holder ever attaches, evaluates or trades,
 *  so any number of API instances may have BOT_RUNNER_ENABLED=true; one leads, the rest stand by
 *  and take over within the lease ttl if the leader dies. Returns null if Deriv isn't configured. */
export function startBotRunnerWithLease(ttlMs?: number): RunnerLease | null {
  const store = new PgLeaseStore(prisma);
  // Constructed before the runner so the runner's gate can reference it.
  const created: RunnerLease = new RunnerLease({
    store,
    name: BOT_RUNNER_LEASE_NAME,
    ttlMs,
    onAcquired: async () => {
      const runner = getBotRunner();
      if (runner) await runner.start();
    },
    onLost: () => instance?.shutdown(),
  });
  lease = created;
  created.start();
  return created;
}
