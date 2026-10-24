import { EventEmitter } from "node:events";
import { logger } from "../../lib/logger.js";
import { SlidingWindowLimiter } from "../../lib/slidingWindowLimiter.js";
import { DerivPublicClient, type ConnectionStatus } from "./derivPublicClient.js";
import {
  activeSymbolsResponseSchema,
  candlesResponseSchema,
  contractsForResponseSchema,
  proposalResponseSchema,
  tickPushSchema,
  type ActiveSymbol,
  type Candle,
  type ContractFor,
  type DerivTick,
  type Proposal,
  type ProposalRequest,
} from "./market.schemas.js";

// Sits between the raw Deriv wire client and the rest of the app. Everything here shares
// ONE DerivPublicClient connection and ONE rate-limit budget across every app user — see
// docs/phase1-architecture.md §2's corrected table: active_symbols + ticks + ticks_history
// together draw on a single 220-requests/minute budget for this whole backend process.
const ALL_OTHER_CALLS_PER_MINUTE = 220;
const RATE_LIMIT_SAFETY_MARGIN = 20; // stay under the documented cap, don't graze it
const SYMBOLS_CACHE_TTL_MS = 30_000;

interface TickSubscription {
  subscriptionId: string | null; // null while the initial subscribe request is in flight
  callbacks: Set<(tick: DerivTick) => void>;
}

export class MarketDataGateway extends EventEmitter {
  private client: DerivPublicClient;
  private limiter = new SlidingWindowLimiter(ALL_OTHER_CALLS_PER_MINUTE - RATE_LIMIT_SAFETY_MARGIN, 60_000);
  private tickSubs = new Map<string, TickSubscription>();
  private symbolsCache: { data: ActiveSymbol[]; at: number } | null = null;

  constructor(url = "wss://api.derivws.com/trading/v1/options/ws/public", clientFactory?: () => DerivPublicClient) {
    super();
    this.client = clientFactory ? clientFactory() : new DerivPublicClient(url);
    this.client.onReconnect = () => this.resubscribeAll();
    this.client.on("status", (status: ConnectionStatus) => this.emit("status", status));
    this.client.on("message", (msg) => this.handleMessage(msg));
  }

  start(): void {
    this.client.connect();
  }

  stop(): void {
    this.client.close();
  }

  getStatus(): ConnectionStatus {
    return this.client.getStatus();
  }

  async getActiveSymbols(): Promise<ActiveSymbol[]> {
    if (this.symbolsCache && Date.now() - this.symbolsCache.at < SYMBOLS_CACHE_TTL_MS) {
      return this.symbolsCache.data;
    }
    const raw = await this.limiter.schedule(() => this.client.request({ active_symbols: "brief" }));
    const parsed = activeSymbolsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error({ issues: parsed.error.issues }, "active_symbols response did not match the expected shape");
      throw new Error("Unexpected response from Deriv");
    }
    this.symbolsCache = { data: parsed.data.active_symbols, at: Date.now() };
    return parsed.data.active_symbols;
  }

  async getCandles(symbol: string, granularity: number, count: number): Promise<{ candles: Candle[]; pipSize: number | null }> {
    const raw = await this.limiter.schedule(() =>
      this.client.request({ ticks_history: symbol, end: "latest", style: "candles", granularity, count, subscribe: 0 }),
    );
    const parsed = candlesResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error({ issues: parsed.error.issues, symbol }, "ticks_history response did not match the expected shape");
      throw new Error("Unexpected response from Deriv");
    }
    return { candles: parsed.data.candles, pipSize: parsed.data.pip_size ?? null };
  }

  /** Returns an unsubscribe function. Multiple callers watching the same symbol share ONE
   *  upstream Deriv subscription — only the last unsubscribe actually calls `forget`. */
  subscribeTicks(symbol: string, onTick: (tick: DerivTick) => void): () => void {
    let entry = this.tickSubs.get(symbol);
    const isFirstSubscriber = !entry;
    if (!entry) {
      entry = { subscriptionId: null, callbacks: new Set() };
      this.tickSubs.set(symbol, entry);
    }
    entry.callbacks.add(onTick);

    if (isFirstSubscriber) {
      void this.startTickStream(symbol, entry);
    }

    return () => this.unsubscribeTicks(symbol, onTick);
  }

  private async startTickStream(symbol: string, entry: TickSubscription) {
    try {
      const raw = await this.limiter.schedule(() => this.client.request({ ticks: symbol, subscribe: 1 }));
      const subId = (raw as { subscription?: { id?: string } }).subscription?.id;
      entry.subscriptionId = typeof subId === "string" ? subId : null;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, symbol }, "failed to subscribe to ticks");
      // Leave the entry in place with subscriptionId null; resubscribeAll() (on the next
      // reconnect) or a future subscriber joining will retry. We don't drop callbacks —
      // the caller asked to watch this symbol and hasn't unsubscribed.
    }
  }

  private unsubscribeTicks(symbol: string, onTick: (tick: DerivTick) => void) {
    const entry = this.tickSubs.get(symbol);
    if (!entry) return;
    entry.callbacks.delete(onTick);
    if (entry.callbacks.size > 0) return;

    this.tickSubs.delete(symbol);
    if (entry.subscriptionId) {
      this.client.send({ forget: entry.subscriptionId }); // best-effort; connection may already be gone
    }
  }

  private resubscribeAll() {
    for (const [symbol, entry] of this.tickSubs) {
      entry.subscriptionId = null;
      void this.startTickStream(symbol, entry);
    }
  }

  /** Confirmed no-auth (developers.deriv.com/comparison/contracts-for/) — which contract
   *  types + parameters a symbol actually supports, so the trade ticket only ever offers
   *  combinations Deriv will accept. Never hardcode this list in the frontend. */
  async getContractsFor(symbol: string): Promise<ContractFor[]> {
    const raw = await this.limiter.schedule(() => this.client.request({ contracts_for: symbol }));
    const parsed = contractsForResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error({ issues: parsed.error.issues, symbol }, "contracts_for response did not match the expected shape");
      throw new Error("Unexpected response from Deriv");
    }
    return parsed.data.contracts_for.available;
  }

  /** Confirmed no-auth (`auth_required: 0` in proposal_request.schema.json) — a price quote
   *  for a potential contract. The `id` this returns is what `buy` is actually called with;
   *  nothing here is itself a trade. */
  async getProposal(params: ProposalRequest): Promise<Proposal> {
    const raw = await this.limiter.schedule(() => this.client.request({ proposal: 1, ...params }));
    const parsed = proposalResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error({ issues: parsed.error.issues, params }, "proposal response did not match the expected shape");
      throw new Error("Unexpected response from Deriv");
    }
    return parsed.data.proposal;
  }

  private handleMessage(msg: unknown) {
    const parsed = tickPushSchema.safeParse(msg);
    if (!parsed.success) return; // not a tick push — active_symbols/ticks_history replies are handled via request()'s own correlation
    const entry = this.tickSubs.get(parsed.data.tick.symbol);
    if (!entry) return; // stale push after we unsubscribed but before `forget` was acknowledged
    for (const cb of entry.callbacks) cb(parsed.data.tick);
  }
}
