import { EventEmitter } from "node:events";
import { logger } from "../../lib/logger.js";
import type { DerivClientLike } from "../deriv/deriv.client.js";
import { DerivPrivateClient } from "./derivPrivateClient.js";
import {
  balancePushSchema,
  buyResponseSchema,
  openContractPushSchema,
  portfolioResponseSchema,
  profitTableResponseSchema,
  sellResponseSchema,
  type Balance,
  type BuyResult,
  type OpenContract,
  type PortfolioContract,
  type ProfitTableEntry,
  type SellResult,
} from "./trading.schemas.js";

// Mirrors MarketDataGateway's ref-counted subscription-sharing pattern (Phase 4), but for
// AUTHENTICATED per-(user, deriv account) connections instead of one shared public one.
// Every caller interested in a given user's account shares exactly ONE DerivPrivateClient;
// `forget`/disconnect only happens once nobody is left. Unlike the public gateway, an idle
// authenticated connection is also torn down after a grace period — there is no reason to
// hold open a per-user Deriv session (and keep re-requesting OTP URLs / sending pings) once
// nothing is watching it.
const TEARDOWN_GRACE_MS = 10_000;
const OTP_RETRY_MS = 3_000;

export interface TokenProvider {
  getAccessToken(userId: string): Promise<string>;
}

interface PositionSub {
  subscriptionId: string | null;
  callbacks: Set<(contract: OpenContract) => void>;
}

interface TradingSession {
  key: string;
  client: DerivPrivateClient;
  refCount: number;
  teardownTimer: NodeJS.Timeout | null;
  positionSubs: Map<number, PositionSub>;
  balanceCallbacks: Set<(balance: Balance) => void>;
  balanceSubscribed: boolean;
}

function sessionKey(userId: string, derivAccountId: string): string {
  return `${userId}:${derivAccountId}`;
}

/**
 * Owns every authenticated per-user Deriv connection used for trading (buy/sell/portfolio/
 * position & balance streaming). Nothing outside this class ever holds a DerivPrivateClient
 * directly — every access goes through acquire/release or one of the request methods below,
 * so the ref-counting and teardown-on-idle invariants can't be bypassed by a caller forgetting
 * to release.
 */
export class TradingSessionManager extends EventEmitter {
  private sessions = new Map<string, TradingSession>();

  constructor(
    private readonly derivClient: DerivClientLike,
    private readonly tokens: TokenProvider,
    private readonly clientFactory: (
      otpUrlProvider: () => Promise<string>,
      getAccessToken: () => Promise<string>,
    ) => DerivPrivateClient = (p, t) => new DerivPrivateClient(p, t),
  ) {
    super();
  }

  async buy(userId: string, derivAccountId: string, proposalId: string, priceAgreed: number): Promise<BuyResult> {
    const session = this.acquire(userId, derivAccountId);
    try {
      const raw = await this.requestWithRetry(session, { buy: proposalId, price: priceAgreed });
      const parsed = buyResponseSchema.safeParse(raw);
      if (!parsed.success) {
        logger.error({ issues: parsed.error.issues }, "buy response did not match the expected shape");
        throw new Error("Deriv returned an unexpected buy response");
      }
      return parsed.data.buy;
    } finally {
      this.release(userId, derivAccountId);
    }
  }

  async sell(userId: string, derivAccountId: string, contractId: number, minPrice: number): Promise<SellResult> {
    const session = this.acquire(userId, derivAccountId);
    try {
      const raw = await this.requestWithRetry(session, { sell: contractId, price: minPrice });
      const parsed = sellResponseSchema.safeParse(raw);
      if (!parsed.success) {
        logger.error({ issues: parsed.error.issues }, "sell response did not match the expected shape");
        throw new Error("Deriv returned an unexpected sell response");
      }
      return parsed.data.sell;
    } finally {
      this.release(userId, derivAccountId);
    }
  }

  async getPortfolio(userId: string, derivAccountId: string): Promise<PortfolioContract[]> {
    const session = this.acquire(userId, derivAccountId);
    try {
      const raw = await this.requestWithRetry(session, { portfolio: 1 });
      const parsed = portfolioResponseSchema.safeParse(raw);
      if (!parsed.success) {
        logger.error({ issues: parsed.error.issues }, "portfolio response did not match the expected shape");
        throw new Error("Deriv returned an unexpected portfolio response");
      }
      return parsed.data.portfolio.contracts;
    } finally {
      this.release(userId, derivAccountId);
    }
  }

  /** `opts` are the request fields verified against Deriv's profit_table schema: `offset`,
   *  `sort`, `date_from`/`date_to` (epoch seconds), and `description: 1` — without which Deriv
   *  omits `underlying_symbol`/`contract_type` from each row. Omitting `opts` keeps the exact
   *  original request shape. */
  async getProfitTable(
    userId: string,
    derivAccountId: string,
    limit: number,
    opts: { offset?: number; sort?: "ASC" | "DESC"; dateFrom?: number; dateTo?: number; description?: boolean } = {},
  ): Promise<ProfitTableEntry[]> {
    const session = this.acquire(userId, derivAccountId);
    try {
      const raw = await this.requestWithRetry(session, {
        profit_table: 1,
        limit,
        sort: opts.sort ?? "DESC",
        ...(opts.offset ? { offset: opts.offset } : {}),
        ...(opts.dateFrom !== undefined ? { date_from: String(opts.dateFrom) } : {}),
        ...(opts.dateTo !== undefined ? { date_to: String(opts.dateTo) } : {}),
        ...(opts.description ? { description: 1 } : {}),
      });
      const parsed = profitTableResponseSchema.safeParse(raw);
      if (!parsed.success) {
        logger.error({ issues: parsed.error.issues }, "profit_table response did not match the expected shape");
        throw new Error("Deriv returned an unexpected profit_table response");
      }
      return parsed.data.profit_table.transactions;
    } finally {
      this.release(userId, derivAccountId);
    }
  }

  /** Returns an unsubscribe function. Multiple watchers of the SAME contract on the SAME
   *  (user, account) share one upstream `proposal_open_contract` subscription. */
  subscribePosition(userId: string, derivAccountId: string, contractId: number, onUpdate: (contract: OpenContract) => void): () => void {
    const session = this.acquire(userId, derivAccountId);
    let sub = session.positionSubs.get(contractId);
    const isFirst = !sub;
    if (!sub) {
      sub = { subscriptionId: null, callbacks: new Set() };
      session.positionSubs.set(contractId, sub);
    }
    sub.callbacks.add(onUpdate);
    if (isFirst) void this.startPositionStream(session, contractId, sub);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = session.positionSubs.get(contractId);
      if (current) {
        current.callbacks.delete(onUpdate);
        if (current.callbacks.size === 0) {
          session.positionSubs.delete(contractId);
          if (current.subscriptionId) session.client.send({ forget: current.subscriptionId });
        }
      }
      this.release(userId, derivAccountId);
    };
  }

  /** Same ref-counted pattern for the account's live balance stream. */
  subscribeBalance(userId: string, derivAccountId: string, onUpdate: (balance: Balance) => void): () => void {
    const session = this.acquire(userId, derivAccountId);
    const isFirst = session.balanceCallbacks.size === 0;
    session.balanceCallbacks.add(onUpdate);
    if (isFirst && !session.balanceSubscribed) {
      session.balanceSubscribed = true;
      void this.startBalanceStream(session);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.balanceCallbacks.delete(onUpdate);
      this.release(userId, derivAccountId);
    };
  }

  /** For graceful process shutdown / tests — closes every live connection immediately. */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      if (session.teardownTimer) clearTimeout(session.teardownTimer);
      session.client.close();
    }
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------

  private acquire(userId: string, derivAccountId: string): TradingSession {
    const key = sessionKey(userId, derivAccountId);
    let session = this.sessions.get(key);

    if (!session) {
      const client = this.clientFactory(
        async () => {
          const token = await this.tokens.getAccessToken(userId);
          return this.derivClient.requestOtp(token, derivAccountId);
        },
        () => this.tokens.getAccessToken(userId),
      );
      session = {
        key,
        client,
        refCount: 0,
        teardownTimer: null,
        positionSubs: new Map(),
        balanceCallbacks: new Set(),
        balanceSubscribed: false,
      };
      client.on("message", (msg: unknown) => this.handlePush(key, msg));
      this.sessions.set(key, session);
      client.connect();
    }

    if (session.teardownTimer) {
      clearTimeout(session.teardownTimer);
      session.teardownTimer = null;
    }
    session.refCount++;
    return session;
  }

  private release(userId: string, derivAccountId: string): void {
    const key = sessionKey(userId, derivAccountId);
    const session = this.sessions.get(key);
    if (!session) return;

    session.refCount = Math.max(0, session.refCount - 1);
    if (session.refCount > 0) return;

    session.teardownTimer = setTimeout(() => {
      const current = this.sessions.get(key);
      if (!current || current.refCount > 0) return;
      current.client.close();
      this.sessions.delete(key);
    }, TEARDOWN_GRACE_MS);
  }

  private async requestWithRetry(session: TradingSession, message: Record<string, unknown>) {
    try {
      return await session.client.request(message);
    } catch (err) {
      // The OTP URL is fetched fresh on every (re)connect, so a request made just after a
      // reconnect can legitimately race the new connection coming up. One short retry
      // covers that window without masking a genuinely dead connection.
      await new Promise((resolve) => setTimeout(resolve, OTP_RETRY_MS));
      if (session.client.getStatus() !== "open") {
        throw err instanceof Error ? err : new Error(String(err));
      }
      return session.client.request(message);
    }
  }

  private async startPositionStream(session: TradingSession, contractId: number, sub: PositionSub) {
    try {
      const raw = await session.client.request({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
      const subId = (raw as { subscription?: { id?: string } }).subscription?.id;
      sub.subscriptionId = typeof subId === "string" ? subId : null;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, contractId }, "failed to subscribe to contract updates");
    }
  }

  private async startBalanceStream(session: TradingSession) {
    try {
      await session.client.request({ balance: 1, subscribe: 1 });
    } catch (err) {
      session.balanceSubscribed = false;
      logger.warn({ err: err instanceof Error ? err.message : err, key: session.key }, "failed to subscribe to balance updates");
    }
  }

  private handlePush(key: string, msg: unknown) {
    const session = this.sessions.get(key);
    if (!session) return;

    const openContract = openContractPushSchema.safeParse(msg);
    if (openContract.success) {
      const sub = session.positionSubs.get(openContract.data.proposal_open_contract.contract_id);
      if (sub) for (const cb of sub.callbacks) cb(openContract.data.proposal_open_contract);
      return;
    }

    const balance = balancePushSchema.safeParse(msg);
    if (balance.success) {
      for (const cb of session.balanceCallbacks) cb(balance.data.balance);
    }
  }
}
