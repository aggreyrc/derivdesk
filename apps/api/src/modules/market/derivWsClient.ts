import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { logger } from "../../lib/logger.js";

// Generalized low-level JSON-RPC-over-WebSocket client for Deriv's gateways. Originally this
// logic lived only in derivPublicClient.ts (Phase 4, unauthenticated, a fixed URL). Phase 5
// needs the identical req_id/ping/reconnect machinery for the AUTHENTICATED side too, but an
// authenticated connection's URL is a one-time-password URL that must be re-requested from
// Deriv's REST API on every (re)connect — it cannot be a constructor constant. This class
// generalizes the URL from a string to a provider function so both cases share one
// implementation; derivPublicClient.ts now just wraps a constant in a closure.
//
// Wire protocol verified against developers.deriv.com/docs/ + /comparison/ (Sept 2026):
//  - Every request may carry a `req_id`; the response echoes it back at
//    `response.req_id` OR nested at `response.echo_req.req_id` — different endpoints were
//    observed doing either, so callers correlate on whichever is present.
//  - Errors arrive as `{ error: { code, message }, msg_type, ... }` on an otherwise-200 frame,
//    not as a WebSocket close or an HTTP error — always inspect `error` before trusting data.
//  - Streaming responses (ticks, ticks_history/proposal_open_contract/balance with
//    subscribe:1) carry `subscription: { id }`; `forget`/`forget_all` release them.

const PING_INTERVAL_MS = 30_000; // per developers.deriv.com/docs/best-practices/
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;

export type DerivMessage = Record<string, unknown> & { msg_type?: string; req_id?: number; echo_req?: { req_id?: number } };

interface PendingRequest {
  resolve: (msg: DerivMessage) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * Emits:
 *  - "status" (ConnectionStatus)
 *  - "message" (DerivMessage) — every inbound frame, including unsolicited subscription pushes
 */
export class DerivWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "closed";
  private reqIdCounter = 1;
  private pending = new Map<number, PendingRequest>();
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closedByCaller = false;
  /** Re-sent, in order, immediately after every (re)connect. */
  onReconnect: (() => void) | null = null;

  constructor(
    // Returning a plain string (DerivPublicClient's case) connects in the SAME tick as
    // connect() with no microtask delay — Phase 4's tests depend on this exact timing, so
    // this is handled specially in open() below rather than always awaiting.
    private readonly urlProvider: () => Promise<string> | string,
    private readonly wsFactory: (url: string) => WebSocket = (u) => new WebSocket(u),
  ) {
    super();
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  connect(): void {
    this.closedByCaller = false;
    this.open();
  }

  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopPing();
    this.ws?.close();
    this.rejectAllPending(new Error("Connection closed"));
    this.setStatus("closed");
  }

  /** Fire-and-forget (subscribe/forget calls where we don't need to await the ack). */
  send(message: Record<string, unknown>): void {
    const withId = { ...message, req_id: this.reqIdCounter++ };
    this.ws?.send(JSON.stringify(withId));
  }

  /** Sends a request and resolves with its correlated response, or rejects on timeout/error/disconnect. */
  request(message: Record<string, unknown>): Promise<DerivMessage> {
    if (!this.ws || this.status !== "open") {
      return Promise.reject(new Error("Not connected to Deriv"));
    }
    const reqId = this.reqIdCounter++;
    const withId = { ...message, req_id: reqId };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("Request to Deriv timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve, reject, timeout });
      this.ws!.send(JSON.stringify(withId));
    });
  }

  private open() {
    this.setStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const maybeUrl = this.urlProvider();

    if (typeof (maybeUrl as Promise<string>)?.then === "function") {
      (maybeUrl as Promise<string>).then(
        (url) => this.connectTo(url),
        (err: unknown) => {
          logger.warn({ err: err instanceof Error ? err.message : err }, "failed to obtain a Deriv connection URL");
          this.handleDisconnect();
        },
      );
    } else {
      // Synchronous case: connect in the SAME tick, no microtask delay.
      this.connectTo(maybeUrl as string);
    }
  }

  private connectTo(url: string) {
    if (this.closedByCaller) return;
    const ws = this.wsFactory(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.setStatus("open");
      this.startPing();
      this.onReconnect?.();
    });

    ws.on("message", (data) => {
      let msg: DerivMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        logger.warn("received non-JSON frame from Deriv");
        return;
      }

      const reqId = typeof msg.req_id === "number" ? msg.req_id : msg.echo_req?.req_id;
      if (typeof reqId === "number") {
        const pending = this.pending.get(reqId);
        if (pending) {
          this.pending.delete(reqId);
          clearTimeout(pending.timeout);
          if (msg.error) {
            const err = msg.error as { code?: string; message?: string };
            pending.reject(new Error(err.message ?? err.code ?? "Deriv returned an error"));
          } else {
            pending.resolve(msg);
          }
        }
      }

      // Every message also goes out as an event — subscription pushes have no pending
      // request to resolve (subscribe calls resolve immediately; pushes arrive later).
      this.emit("message", msg);
    });

    ws.on("close", () => this.handleDisconnect());
    ws.on("error", (err) => {
      logger.warn({ err: err.message }, "Deriv gateway socket error");
      // 'close' always follows 'error' for the ws package; reconnect logic lives there.
    });
  }

  private handleDisconnect() {
    this.stopPing();
    this.rejectAllPending(new Error("Connection to Deriv lost"));
    if (this.closedByCaller) {
      this.setStatus("closed");
      return;
    }
    this.setStatus("reconnecting");
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, MAX_BACKOFF_MS) + Math.floor(Math.random() * 500);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.send({ ping: 1 });
    }, PING_INTERVAL_MS);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private rejectAllPending(err: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    this.pending.clear();
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }
}
