import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import cookie from "cookie";
import { getActiveSession, SESSION_COOKIE_NAME } from "../lib/session.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { marketDataGateway } from "../modules/market/market.instance.js";
import type { DerivTick } from "../modules/market/market.schemas.js";
import { getTradingSessionManager } from "../modules/trading/trading.instance.js";
import { HttpError } from "../middleware/errorHandler.js";
import type { Balance, OpenContract } from "../modules/trading/trading.schemas.js";
import { CLOSE_SESSION_ENDED, MAX_SOCKETS_PER_USER, countSocketsForUser, registerSocket } from "./socketRegistry.js";
import {
  HEARTBEAT_MS,
  MAX_MESSAGE_BYTES,
  MAX_POSITION_SUBSCRIPTIONS,
  MAX_TICK_SUBSCRIPTIONS,
  MessageRateLimiter,
  isValidContractId,
} from "./wsLimits.js";

// Hop 1 of the two-hop WS design (docs/phase1-architecture.md §8): browser <-> this gateway.
// Components never see a raw Deriv message shape — only these normalized event types.
// Phase 5 adds BALANCE_UPDATED / POSITION_UPDATED / TRADE_ERROR. CONTRACT_UPDATED and
// TRANSACTION_UPDATED (full transaction streaming beyond position P/L) remain for a later
// phase — see the Phase 5 README section's "known limitations".
type ServerEvent =
  | { type: "CONNECTION_CHANGED"; status: string }
  | { type: "MARKET_TICK"; symbol: string; quote: number; epoch: number; bid?: number; ask?: number }
  | { type: "BALANCE_UPDATED"; balance: number; currency: string }
  | { type: "POSITION_UPDATED"; contract: OpenContract }
  | { type: "TRADE_ERROR"; context: string; message: string }
  | { type: "SUBSCRIPTION_REJECTED"; context: string; message: string };

type ClientEvent =
  | { type: "SUBSCRIBE_TICKS"; symbol: string }
  | { type: "UNSUBSCRIBE_TICKS"; symbol: string }
  | { type: "SUBSCRIBE_POSITION"; contractId: number }
  | { type: "UNSUBSCRIBE_POSITION"; contractId: number };

const SYMBOL_PATTERN = /^\w{2,30}$/; // sanity check on OUR gateway; Deriv itself dropped this constraint (see market.schemas.ts)
const WS_PATH = "/ws";

/** Same rule as trading.controller.ts's getActiveAccount: NEVER trust a client-supplied
 *  account id over this WS connection either — everything here is derived from the
 *  verified session row. Returns null rather than throwing; a connection with no active
 *  (or no longer active) account simply gets no balance/position streaming. */
async function resolveActiveDerivAccountId(userId: string, sessionId: string): Promise<string | null> {
  const session = await prisma.session.findFirst({ where: { id: sessionId, userId }, include: { activeDerivAccount: true } });
  if (!session?.activeDerivAccount || session.activeDerivAccount.status !== "active") return null;
  return session.activeDerivAccount.derivAccountId;
}

function send(ws: WebSocket, event: ServerEvent) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
}

export function attachWsGateway(httpServer: HttpServer, corsOrigin: string, opts: { heartbeatMs?: number } = {}) {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  httpServer.on("upgrade", (req, socket, head) => {
    // An error on the raw socket during the handshake (client reset) is otherwise an unhandled
    // 'error' event.
    socket.on("error", () => socket.destroy());
    if (req.url !== WS_PATH) {
      socket.destroy();
      return;
    }
    // Manual origin check: the browser's WebSocket handshake carries an Origin header but,
    // unlike fetch(), there is no CORS preflight to enforce it for us.
    const origin = req.headers.origin;
    if (origin !== corsOrigin) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    authenticate(req)
      .then((auth) => {
        if (!auth) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        if (countSocketsForUser(auth.userId) >= MAX_SOCKETS_PER_USER) {
          socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          (ws as AuthenticatedSocket).auth = auth;
          wss.emit("connection", ws);
        });
      })
      .catch((err) => {
        logger.error({ err }, "WS upgrade authentication failed");
        socket.destroy();
      });
  });

  wss.on("connection", (ws: WebSocket) => {
    const { userId, sessionId } = (ws as AuthenticatedSocket).auth;
    const tickUnsubscribes = new Map<string, () => void>();
    const positionUnsubscribes = new Map<number, () => void>();
    const positionPending = new Set<number>(); // resolving the active account is async; count these toward the cap too
    let balanceUnsubscribe: (() => void) | null = null;
    const unregister = registerSocket(userId, sessionId, ws);
    const rate = new MessageRateLimiter();

    // Heartbeat + session re-validation. The session was checked once at upgrade; without this a
    // socket would keep streaming balance/positions after the session expired, the user was
    // suspended, or the cookie was revoked on another device. Dead peers are reaped too.
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
      getActiveSession(sessionId)
        .then((session) => {
          if (!session) ws.close(CLOSE_SESSION_ENDED, "session ended");
        })
        .catch((err: unknown) => logger.warn({ err }, "WS session re-validation failed (will retry)"));
    }, heartbeatMs);
    heartbeat.unref();

    send(ws, { type: "CONNECTION_CHANGED", status: marketDataGateway.getStatus() });
    const onStatus = (status: string) => send(ws, { type: "CONNECTION_CHANGED", status });
    marketDataGateway.on("status", onStatus);

    // Balance streams automatically for whichever account is active when this socket
    // connects — there's no reason to make the frontend ask for it separately. If the user
    // switches accounts mid-connection, the browser reconnects the socket (same pattern the
    // frontend already uses after account activation), so this doesn't need to react live
    // to that change itself.
    resolveActiveDerivAccountId(userId, sessionId)
      .then((derivAccountId) => {
        if (!derivAccountId || ws.readyState !== WebSocket.OPEN) return;
        balanceUnsubscribe = getTradingSessionManager().subscribeBalance(userId, derivAccountId, (balance: Balance) => {
          send(ws, { type: "BALANCE_UPDATED", balance: balance.balance, currency: balance.currency });
        });
      })
      .catch((err: unknown) => {
        if (err instanceof HttpError) return; // Deriv not configured — no balance streaming, nothing else breaks
        logger.warn({ err }, "failed to start balance streaming for a WS connection");
      });

    ws.on("message", (raw) => {
      if (!rate.allow()) {
        ws.close(1008, "rate limit exceeded"); // policy violation
        return;
      }
      let event: ClientEvent;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return; // silently drop malformed frames rather than crash the connection
      }

      if (event.type === "SUBSCRIBE_TICKS" && typeof event.symbol === "string" && SYMBOL_PATTERN.test(event.symbol)) {
        if (tickUnsubscribes.has(event.symbol)) return; // already subscribed on this connection
        if (tickUnsubscribes.size >= MAX_TICK_SUBSCRIPTIONS) {
          send(ws, { type: "SUBSCRIPTION_REJECTED", context: "SUBSCRIBE_TICKS", message: "Too many symbol subscriptions on this connection" });
          return;
        }
        const unsub = marketDataGateway.subscribeTicks(event.symbol, (tick: DerivTick) => {
          send(ws, { type: "MARKET_TICK", symbol: tick.symbol, quote: tick.quote, epoch: tick.epoch, bid: tick.bid, ask: tick.ask });
        });
        tickUnsubscribes.set(event.symbol, unsub);
      } else if (event.type === "UNSUBSCRIBE_TICKS" && typeof event.symbol === "string") {
        tickUnsubscribes.get(event.symbol)?.();
        tickUnsubscribes.delete(event.symbol);
      } else if (event.type === "SUBSCRIBE_POSITION" && isValidContractId(event.contractId)) {
        if (positionUnsubscribes.has(event.contractId) || positionPending.has(event.contractId)) return;
        if (positionUnsubscribes.size + positionPending.size >= MAX_POSITION_SUBSCRIPTIONS) {
          send(ws, { type: "SUBSCRIPTION_REJECTED", context: "SUBSCRIBE_POSITION", message: "Too many contract subscriptions on this connection" });
          return;
        }
        // Same ownership rule as everywhere else: which Deriv account this watches is
        // re-resolved from the verified session, never taken from the client message.
        const contractId = event.contractId;
        positionPending.add(contractId);
        resolveActiveDerivAccountId(userId, sessionId)
          .then((derivAccountId) => {
            positionPending.delete(contractId);
            if (!derivAccountId || ws.readyState !== WebSocket.OPEN) return;
            const unsub = getTradingSessionManager().subscribePosition(userId, derivAccountId, event.contractId, (contract: OpenContract) => {
              send(ws, { type: "POSITION_UPDATED", contract });
            });
            positionUnsubscribes.set(event.contractId, unsub);
          })
          .catch((err: unknown) => {
            positionPending.delete(contractId);
            const message = err instanceof HttpError ? err.message : "Could not subscribe to this contract";
            send(ws, { type: "TRADE_ERROR", context: "SUBSCRIBE_POSITION", message });
          });
      } else if (event.type === "UNSUBSCRIBE_POSITION" && typeof event.contractId === "number") {
        positionUnsubscribes.get(event.contractId)?.();
        positionUnsubscribes.delete(event.contractId);
      }
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      unregister();
      marketDataGateway.off("status", onStatus);
      for (const unsub of tickUnsubscribes.values()) unsub();
      tickUnsubscribes.clear();
      for (const unsub of positionUnsubscribes.values()) unsub();
      positionUnsubscribes.clear();
      balanceUnsubscribe?.();
      balanceUnsubscribe = null;
    });

    ws.on("error", (err) => logger.warn({ err: err.message }, "client WS connection error"));
  });

  return wss;
}

interface AuthenticatedSocket extends WebSocket {
  auth: { userId: string; sessionId: string };
}

async function authenticate(req: IncomingMessage): Promise<{ userId: string; sessionId: string } | null> {
  const cookies = cookie.parse(req.headers.cookie ?? "");
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return null;
  const session = await getActiveSession(sessionId);
  return session ? { userId: session.userId, sessionId: session.id } : null;
}
