// Browser-side client for apps/api's WS gateway (Hop 1 of docs/phase1-architecture.md §8).
// One shared connection for the whole tab, ref-counted per symbol/contract — mirrors the
// backend's own pattern for its pooled Deriv connection, for the same reason: don't
// multiply requests. Phase 5 adds balance and per-contract position streaming over this
// SAME socket (the backend gateway multiplexes all of it over one `/ws` connection).

import type { OpenContract } from "@derivdesk/shared-types";
import { API_BASE_URL, buildWsUrl } from "./apiBase";

export interface MarketTick {
  symbol: string;
  quote: number;
  epoch: number;
  bid?: number;
  ask?: number;
}

export interface LiveBalance {
  balance: number;
  currency: string;
}

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

type Listener = (tick: MarketTick) => void;
type BalanceListener = (balance: LiveBalance) => void;
type PositionListener = (contract: OpenContract) => void;
type StatusListener = (status: ConnectionStatus) => void;
type TradeErrorListener = (err: { context: string; message: string }) => void;

function wsUrl(): string {
  return buildWsUrl(API_BASE_URL, window.location);
}

class MarketSocket {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "closed";
  private symbolListeners = new Map<string, Set<Listener>>();
  private positionListeners = new Map<number, Set<PositionListener>>();
  private balanceListeners = new Set<BalanceListener>();
  private statusListeners = new Set<StatusListener>();
  private tradeErrorListeners = new Set<TradeErrorListener>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private ensureConnected() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus("open");
      // Server-side subscriptions don't survive a reconnect — re-request everything we still
      // care about. Balance streams automatically for the session's active account on the
      // server side, so there's nothing to re-send for that; only per-symbol/per-contract
      // subscriptions need replaying.
      for (const symbol of this.symbolListeners.keys()) this.sendSubscribe(symbol);
      for (const contractId of this.positionListeners.keys()) this.sendSubscribePosition(contractId);
    };

    ws.onmessage = (event) => {
      let msg: {
        type: string;
        symbol?: string;
        quote?: number;
        epoch?: number;
        bid?: number;
        ask?: number;
        status?: string;
        balance?: number;
        currency?: string;
        contract?: OpenContract;
        context?: string;
        message?: string;
      };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "MARKET_TICK" && msg.symbol) {
        const listeners = this.symbolListeners.get(msg.symbol);
        listeners?.forEach((cb) => cb({ symbol: msg.symbol!, quote: msg.quote!, epoch: msg.epoch!, bid: msg.bid, ask: msg.ask }));
      } else if (msg.type === "CONNECTION_CHANGED" && msg.status) {
        // This reports the BACKEND's upstream Deriv status, not this browser connection's
        // own status — surfaced as-is so the UI can show "reconnecting to Deriv" distinctly.
        this.statusListeners.forEach((cb) => cb(msg.status as ConnectionStatus));
      } else if (msg.type === "BALANCE_UPDATED" && typeof msg.balance === "number" && msg.currency) {
        this.balanceListeners.forEach((cb) => cb({ balance: msg.balance!, currency: msg.currency! }));
      } else if (msg.type === "POSITION_UPDATED" && msg.contract) {
        const listeners = this.positionListeners.get(msg.contract.contract_id);
        listeners?.forEach((cb) => cb(msg.contract!));
      } else if (msg.type === "TRADE_ERROR" && msg.context && msg.message) {
        this.tradeErrorListeners.forEach((cb) => cb({ context: msg.context!, message: msg.message! }));
      }
    };

    ws.onclose = () => {
      this.setStatus("reconnecting");
      const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30_000) + Math.random() * 500;
      this.reconnectAttempt++;
      this.reconnectTimer = setTimeout(() => this.ensureConnected(), delay);
    };
  }

  private sendSubscribe(symbol: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "SUBSCRIBE_TICKS", symbol }));
  }

  private sendSubscribePosition(contractId: number) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "SUBSCRIBE_POSITION", contractId }));
  }

  subscribe(symbol: string, cb: Listener): () => void {
    this.ensureConnected();
    let set = this.symbolListeners.get(symbol);
    const isFirst = !set;
    if (!set) {
      set = new Set();
      this.symbolListeners.set(symbol, set);
    }
    set.add(cb);
    if (isFirst) this.sendSubscribe(symbol);

    return () => {
      const s = this.symbolListeners.get(symbol);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        this.symbolListeners.delete(symbol);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "UNSUBSCRIBE_TICKS", symbol }));
      }
    };
  }

  /** Live P/L and status for one open contract — used by the Portfolio page. */
  subscribePosition(contractId: number, cb: PositionListener): () => void {
    this.ensureConnected();
    let set = this.positionListeners.get(contractId);
    const isFirst = !set;
    if (!set) {
      set = new Set();
      this.positionListeners.set(contractId, set);
    }
    set.add(cb);
    if (isFirst) this.sendSubscribePosition(contractId);

    return () => {
      const s = this.positionListeners.get(contractId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        this.positionListeners.delete(contractId);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "UNSUBSCRIBE_POSITION", contractId }));
      }
    };
  }

  /** Live balance for whichever account is active — the server subscribes this
   *  automatically once the socket authenticates, so there's nothing to send here. */
  onBalance(cb: BalanceListener): () => void {
    this.ensureConnected();
    this.balanceListeners.add(cb);
    return () => this.balanceListeners.delete(cb);
  }

  onTradeError(cb: TradeErrorListener): () => void {
    this.tradeErrorListeners.add(cb);
    return () => this.tradeErrorListeners.delete(cb);
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
  }

  getStatus() {
    return this.status;
  }
}

/** One socket per browser tab, shared across every component that calls this. */
export const marketSocket = new MarketSocket();
