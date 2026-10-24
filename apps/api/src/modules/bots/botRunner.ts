// The server-side, always-on bot runner (the user chose "server-side, always-on" over a
// browser-driven loop). One in-process runner evaluates every RUNNING BotInstance on a timer,
// independent of whether the owner has the site open.
//
// What keeps this safe to leave unattended:
//  - Fail closed. Anything unexpected (bad definition, expired Deriv auth, a settlement that
//    never arrives, repeated errors) STOPS the instance with a reason; it never guesses and
//    never keeps trading.
//  - One open trade per instance, evaluated on CLOSED candles only, once per candle.
//  - Stake is never higher than the user's configured ladder: if Deriv's quoted price exceeds
//    the intended stake the trade is refused.
//  - Real accounts re-checked on every trade: REAL requires the instance's own confirmReal.
//  - The runner only ever trades the instance owner's OWN account through their own
//    authenticated session (TradingSessionManager). Admin has no path into any of this.
//  - State (ladder position, session P/L, open trade) lives in the database, so a process
//    restart resumes exactly where it left off — see start().
//
// Dependencies are injected so every decision here is unit-testable without Deriv or Postgres.

import type { BotInstance, BotStrategy, DerivAccount, PrismaClient } from "@derivdesk/db";
import { logger } from "../../lib/logger.js";
import type { recordAudit } from "../../lib/audit.js";
import type { MarketDataGateway } from "../market/market.gateway.js";
import type { TradingSessionManager } from "../trading/trading.sessionManager.js";
import { evaluateStrategy } from "./signalEngine.js";
import { strategyDefinitionSchema } from "./strategy.schema.js";
import { botRiskParamsSchema, riskStateSchema, stakingStateSchema } from "./botParams.js";
import { advanceRiskState, advanceStakingState, checkRiskLimits, nextStake, type StopReason } from "./staking.js";

const CANDLE_COUNT = 200; // plenty of history for EMA(25)/MACD(26+9) to be warm
const MAX_CONSECUTIVE_ERRORS = 5;
const STAKE_TOLERANCE = 0.005; // half a cent — rounding slack only
const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 15_000;
const SETTLEMENT_GRACE_MS = 120_000;

// Explicit shape (not Prisma.BotInstanceGetPayload) so this typechecks identically against the
// real generated client and this sandbox's interim typing shim.
type LoadedInstance = BotInstance & { strategy: BotStrategy; derivAccount: DerivAccount; user: { handle: string } };

export interface BotRunnerDeps {
  db: PrismaClient;
  market: Pick<MarketDataGateway, "getCandles" | "getProposal">;
  trading: Pick<TradingSessionManager, "buy" | "subscribePosition">;
  audit: typeof recordAudit;
  now?: () => number;
  /** Leader gate (see lib/runnerLease.ts). The runner only attaches, evaluates and — checked
   *  again immediately before every order — trades while this returns true. Defaults to always
   *  true so a single-process setup and the unit tests behave as before. */
  canTrade?: () => boolean;
}

interface Runtime {
  timer: NodeJS.Timeout | null;
  busy: boolean;
  lastCandleEpoch: number | null;
  consecutiveErrors: number;
  unsubscribe: (() => void) | null;
  settleTimer: NodeJS.Timeout | null;
}

export class BotRunner {
  private runtimes = new Map<string, Runtime>();
  private readonly now: () => number;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;

  constructor(private readonly deps: BotRunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Call once at process start: re-attaches every instance that was RUNNING when the last
   *  process stopped, and resumes watching any trade still OPEN for it. */
  async start(options: { reconcileEveryMs?: number } = {}): Promise<void> {
    const running = await this.deps.db.botInstance.findMany({ where: { status: "RUNNING" } });
    for (const { id } of running) await this.attach(id);
    logger.info({ count: running.length }, "bot runner started");
    // A bot started or stopped through ANOTHER API instance only changes its database row; the
    // leader notices here. (attach() on a non-leader is a deliberate no-op.)
    const every = options.reconcileEveryMs ?? 10_000;
    if (every > 0 && !this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => void this.reconcile(), every);
      this.reconcileTimer.unref?.();
    }
  }

  /** Graceful shutdown: stops timers/subscriptions only. Instance rows stay RUNNING so the
   *  next process (or the next leader) picks them up. Also what runs when leadership is lost. */
  shutdown(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const id of [...this.runtimes.keys()]) this.detach(id);
  }

  /** Makes the in-memory set of attached instances match the database: attaches RUNNING ones we
   *  are not watching yet, and lets go of ones that are no longer RUNNING. Public for tests. */
  async reconcile(): Promise<void> {
    if (this.reconciling || !this.canTrade()) return;
    this.reconciling = true;
    try {
      const running = await this.deps.db.botInstance.findMany({ where: { status: "RUNNING" } });
      const runningIds = new Set(running.map((r) => r.id));
      for (const id of runningIds) if (!this.runtimes.has(id)) await this.attach(id);
      for (const id of [...this.runtimes.keys()]) if (!runningIds.has(id)) this.release(id);
    } catch (err) {
      logger.error({ err }, "bot runner reconcile failed");
    } finally {
      this.reconciling = false;
    }
  }

  private canTrade(): boolean {
    return this.deps.canTrade ? this.deps.canTrade() : true;
  }

  /** Begin (or resume) evaluating an instance. The caller has already set status = RUNNING. */
  async attach(instanceId: string, options: { evaluateImmediately?: boolean } = {}): Promise<void> {
    if (this.runtimes.has(instanceId)) return;
    if (!this.canTrade()) return; // not the leader: the leader's reconcile() will pick this bot up
    const runtime: Runtime = { timer: null, busy: false, lastCandleEpoch: null, consecutiveErrors: 0, unsubscribe: null, settleTimer: null };
    this.runtimes.set(instanceId, runtime);

    // A trade left OPEN by a previous process: resume watching it before anything new trades.
    const open = await this.deps.db.botTrade.findFirst({ where: { botInstanceId: instanceId, status: "OPEN" } });
    if (open) {
      const inst = await this.loadInstance(instanceId);
      if (inst) this.watchTrade(inst, open.id, Number(open.contractId), Number(open.stake), open.stakeStep, 0);
    }

    const def = await this.loadInstance(instanceId).then((i) => strategyDefinitionSchema.safeParse(i?.strategy.definition));
    const granularityMs = def.success ? def.data.candleGranularitySeconds * 1000 : MAX_POLL_MS;
    const pollMs = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, granularityMs / 4));
    runtime.timer = setInterval(() => void this.evaluateOnce(instanceId), pollMs);
    if (options.evaluateImmediately ?? true) void this.evaluateOnce(instanceId);
  }

  detach(instanceId: string): void {
    const rt = this.runtimes.get(instanceId);
    if (!rt) return;
    if (rt.timer) clearInterval(rt.timer);
    if (rt.settleTimer) clearTimeout(rt.settleTimer);
    rt.unsubscribe?.();
    this.runtimes.delete(instanceId);
  }

  /** Called when a user pauses/stops an instance. With no trade open it detaches at once. With
   *  a trade open it deliberately does NOT drop the settlement watch — the trade is real money
   *  on Deriv and will settle regardless, so we keep watching it, record the outcome, and
   *  detach on our own once the (no-longer-RUNNING) instance has nothing left to watch. */
  release(instanceId: string): void {
    const rt = this.runtimes.get(instanceId);
    if (rt && !rt.unsubscribe) this.detach(instanceId);
  }

  attachedCount(): number {
    return this.runtimes.size;
  }

  isAttached(instanceId: string): boolean {
    return this.runtimes.has(instanceId);
  }

  private async loadInstance(id: string): Promise<LoadedInstance | null> {
    const row = await this.deps.db.botInstance.findUnique({
      where: { id },
      include: { strategy: true, derivAccount: true, user: { select: { handle: true } } },
    });
    return row as LoadedInstance | null;
  }

  /** One poll cycle. Public so tests (and nothing else) can drive it deterministically. */
  async evaluateOnce(instanceId: string): Promise<void> {
    const rt = this.runtimes.get(instanceId);
    if (!rt || rt.busy || rt.unsubscribe) return; // busy, or a trade is still open: one at a time
    if (!this.canTrade()) return; // leadership lost: shutdown() is on its way, never evaluate meanwhile
    rt.busy = true;
    try {
      const inst = await this.loadInstance(instanceId);
      if (!inst || inst.status !== "RUNNING") {
        this.detach(instanceId); // paused/stopped/deleted elsewhere
        return;
      }

      const account = inst.derivAccount;
      if (account.status !== "active") return this.fail(inst, "ERROR", "ACCOUNT_UNAVAILABLE", "The Deriv account is no longer available");
      if (account.accountType === "REAL" && !inst.confirmReal) {
        return this.fail(inst, "STOPPED", "REAL_ACCOUNT_NOT_CONFIRMED", "Real-money trading was never explicitly confirmed for this bot");
      }

      const def = strategyDefinitionSchema.safeParse(inst.strategy.definition);
      const params = botRiskParamsSchema.safeParse(inst.riskParams);
      const staking = stakingStateSchema.safeParse(inst.stakingState);
      const risk = riskStateSchema.safeParse(inst.riskState);
      if (!def.success || !params.success || !staking.success || !risk.success) {
        return this.fail(inst, "ERROR", "INVALID_CONFIGURATION", "Strategy or risk settings failed validation");
      }

      const gran = def.data.candleGranularitySeconds;
      const { candles } = await this.deps.market.getCandles(inst.symbol, gran, CANDLE_COUNT);
      const nowSec = Math.floor(this.now() / 1000);
      const closed = candles.filter((c) => c.epoch + gran <= nowSec); // drop the still-forming candle
      const latest = closed[closed.length - 1];
      if (!latest || rt.lastCandleEpoch === latest.epoch) return;
      rt.lastCandleEpoch = latest.epoch;
      await this.deps.db.botInstance.update({ where: { id: inst.id }, data: { lastEvaluatedAt: new Date(this.now()) } });

      const stop = checkRiskLimits(params.data.riskLimits, params.data.staking, staking.data, risk.data);
      if (stop) return this.stopForLimit(inst, stop);

      const signal = evaluateStrategy(def.data, closed);
      if (!signal) {
        rt.consecutiveErrors = 0;
        return;
      }

      const stake = nextStake(params.data.staking, staking.data);
      const proposal = await this.deps.market.getProposal({
        contract_type: signal.contractType,
        underlying_symbol: inst.symbol,
        currency: account.currency,
        amount: stake,
        basis: "stake",
        duration: def.data.tradeParams.durationValue,
        duration_unit: def.data.tradeParams.durationUnit,
      });
      const ask = Number(proposal.ask_price);
      if (!Number.isFinite(ask) || ask <= 0) throw new Error("Deriv proposal had no usable price");
      if (ask > stake + STAKE_TOLERANCE) {
        throw new Error(`Quoted price ${ask} exceeds the configured stake ${stake} — trade refused`);
      }

      // Last check before real money moves: leadership may have lapsed during the awaits above.
      if (!this.canTrade()) {
        logger.warn({ instanceId: inst.id }, "bot runner lost its lease before placing a trade — trade skipped");
        return;
      }
      const bought = await this.deps.trading.buy(inst.userId, account.derivAccountId, proposal.id, ask);
      let trade: { id: string };
      try {
        trade = await this.deps.db.botTrade.create({
          data: {
            botInstanceId: inst.id,
            contractId: String(bought.contract_id),
            transactionId: String(bought.transaction_id),
            contractType: signal.contractType,
            stake: String(bought.buy_price),
            stakeStep: staking.data.currentStep,
            placedAt: new Date(bought.purchase_time * 1000),
            status: "OPEN",
          },
        });
      } catch (recordErr) {
        // Money is already committed on Deriv but we can't track it — never keep trading blind.
        logger.error({ recordErr, contractId: bought.contract_id }, "bot trade placed but could not be recorded");
        return this.fail(inst, "ERROR", "TRADE_RECORD_FAILED", `Trade ${bought.contract_id} was placed but could not be recorded — check it on Deriv`);
      }
      await this.deps.audit({
        actorId: inst.userId,
        actorEmail: inst.user.handle,
        action: "bots.trade_placed",
        targetType: "bot_instance",
        targetId: inst.id,
        metadata: { contractId: bought.contract_id, contractType: signal.contractType, stake, accountType: account.accountType, derivAccountId: account.derivAccountId },
      });
      rt.consecutiveErrors = 0;
      this.watchTrade(inst, trade.id, bought.contract_id, stake, staking.data.currentStep, def.data.tradeParams.durationUnit === "t" ? def.data.tradeParams.durationValue * 2_000 : 0);
    } catch (err) {
      await this.handleError(instanceId, err);
    } finally {
      rt.busy = false;
    }
  }

  private watchTrade(inst: LoadedInstance, tradeId: string, contractId: number, stake: number, _step: number, expectedMs: number): void {
    const rt = this.runtimes.get(inst.id);
    if (!rt) return;
    let settled = false;

    rt.settleTimer = setTimeout(() => {
      if (settled) return;
      // Never assume an outcome we haven't seen: stop instead of trading on a guess.
      void this.fail(inst, "ERROR", "SETTLEMENT_NOT_CONFIRMED", `Trade ${contractId} did not settle in time — check it on Deriv`);
    }, Math.max(expectedMs, 0) + SETTLEMENT_GRACE_MS);

    rt.unsubscribe = this.deps.trading.subscribePosition(inst.userId, inst.derivAccount.derivAccountId, contractId, (contract) => {
      if (settled || contract.is_sold !== 1) return;
      settled = true;
      const profit = Number(contract.profit);
      void this.settleTrade(inst.id, tradeId, contract, Number.isFinite(profit) ? profit : null, stake);
    });
  }

  private async settleTrade(instanceId: string, tradeId: string, contract: { payout?: unknown }, profit: number | null, _stake: number): Promise<void> {
    const rt = this.runtimes.get(instanceId);
    if (rt?.settleTimer) clearTimeout(rt.settleTimer);
    rt?.unsubscribe?.();
    if (rt) {
      rt.unsubscribe = null;
      rt.settleTimer = null;
    }

    try {
      const inst = await this.loadInstance(instanceId);
      if (!inst) return;
      if (profit === null) return this.fail(inst, "ERROR", "SETTLEMENT_NOT_CONFIRMED", "Deriv reported the trade sold without a profit figure");

      await this.deps.db.botTrade.update({
        where: { id: tradeId },
        data: { status: "CLOSED", profit: String(profit), payout: contract.payout !== undefined ? String(contract.payout) : null, settledAt: new Date(this.now()) },
      });

      const params = botRiskParamsSchema.parse(inst.riskParams);
      const nextStaking = advanceStakingState(params.staking, stakingStateSchema.parse(inst.stakingState), profit > 0);
      const nextRisk = advanceRiskState(riskStateSchema.parse(inst.riskState), profit);
      await this.deps.db.botInstance.update({ where: { id: inst.id }, data: { stakingState: { ...nextStaking }, riskState: { ...nextRisk } } });

      if (inst.status !== "RUNNING") {
        // Paused/stopped by the user while this trade was open: state is now up to date, so
        // there is nothing left to watch. Don't overwrite the user's own status.
        this.detach(instanceId);
        return;
      }
      const stop = checkRiskLimits(params.riskLimits, params.staking, nextStaking, nextRisk);
      if (stop) await this.stopForLimit(inst, stop);
    } catch (err) {
      await this.handleError(instanceId, err);
    }
  }

  private async stopForLimit(inst: LoadedInstance, reason: StopReason): Promise<void> {
    await this.deps.db.botInstance.update({ where: { id: inst.id }, data: { status: "STOPPED", stopReason: reason, stoppedAt: new Date(this.now()) } });
    this.detach(inst.id);
    await this.deps.audit({ actorId: inst.userId, actorEmail: inst.user.handle, action: "bots.stopped", targetType: "bot_instance", targetId: inst.id, metadata: { reason } });
  }

  private async fail(inst: LoadedInstance, status: "ERROR" | "STOPPED", reason: string, message: string): Promise<void> {
    await this.deps.db.botInstance.update({ where: { id: inst.id }, data: { status, stopReason: reason, lastError: message, stoppedAt: new Date(this.now()) } });
    this.detach(inst.id);
    await this.deps.audit({ actorId: inst.userId, actorEmail: inst.user.handle, action: "bots.stopped", targetType: "bot_instance", targetId: inst.id, metadata: { reason, message } });
  }

  private async handleError(instanceId: string, err: unknown): Promise<void> {
    const rt = this.runtimes.get(instanceId);
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    logger.warn({ instanceId, err: message }, "bot evaluation failed");

    const inst = await this.loadInstance(instanceId).catch(() => null);
    if (!inst) return;
    // Deriv auth is gone: retrying can't help and the user must reconnect.
    if (code === "ReauthRequired") return this.fail(inst, "ERROR", "REAUTH_REQUIRED", "Reconnect your Deriv account to resume this bot");

    await this.deps.db.botInstance.update({ where: { id: inst.id }, data: { lastError: message } }).catch(() => undefined);
    if (rt) {
      rt.consecutiveErrors += 1;
      if (rt.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        await this.fail(inst, "ERROR", "TOO_MANY_ERRORS", `Stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive errors: ${message}`);
      }
    }
  }
}
