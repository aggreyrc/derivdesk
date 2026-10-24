import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

// Real `ws` clients against the real gateway over a real TCP socket. Only the things BEHIND the
// gateway (session lookup, Deriv market data, Deriv trading) are replaced.

const ORIGIN = "http://localhost:5173";
const state = vi.hoisted(() => ({
  sessions: new Map<string, { userId: string }>(),
  subscribed: [] as string[],
  unsubscribed: [] as string[],
  tickListeners: new Map<string, (t: unknown) => void>(),
}));

vi.mock("../../lib/session.js", () => ({
  SESSION_COOKIE_NAME: "derivdesk_session",
  getActiveSession: async (id: string) => {
    const s = state.sessions.get(id);
    return s ? { id, userId: s.userId, user: { handle: "CR1000001", status: "ACTIVE" } } : null;
  },
}));
vi.mock("../../lib/prisma.js", () => ({ prisma: { session: { findFirst: async () => ({ activeDerivAccount: null }) } } }));
vi.mock("../../modules/market/market.instance.js", async () => {
  const { EventEmitter } = await import("node:events");
  const gw = Object.assign(new EventEmitter(), {
    getStatus: () => "open",
    subscribeTicks: (symbol: string, cb: (t: unknown) => void) => {
      state.subscribed.push(symbol);
      state.tickListeners.set(symbol, cb);
      return () => {
        state.unsubscribed.push(symbol);
        state.tickListeners.delete(symbol);
      };
    },
  });
  return { marketDataGateway: gw };
});
vi.mock("../../modules/trading/trading.instance.js", () => ({
  getTradingSessionManager: () => ({ subscribeBalance: () => () => undefined, subscribePosition: () => () => undefined }),
}));

import { attachWsGateway } from "../wsGateway.js";
import { MAX_MESSAGE_BYTES, MAX_POSITION_SUBSCRIPTIONS, MAX_TICK_SUBSCRIPTIONS } from "../wsLimits.js";
import { CLOSE_SESSION_ENDED, MAX_SOCKETS_PER_USER, _resetSocketRegistryForTests, closeSocketsForSession } from "../socketRegistry.js";

let server: Server;
let port: number;
const open: WebSocket[] = [];

beforeAll(async () => {
  server = createServer();
  attachWsGateway(server, ORIGIN, { heartbeatMs: 60 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  open.forEach((w) => w.terminate());
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  state.sessions.clear();
  state.subscribed.length = 0;
  state.unsubscribed.length = 0;
  state.tickListeners.clear();
  _resetSocketRegistryForTests();
});

const url = () => `ws://127.0.0.1:${port}/ws`;

/** Opens a socket and collects every message and the close event. */
function connect(opts: { cookie?: string; origin?: string | null; path?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = `derivdesk_session=${opts.cookie}`;
  if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  const ws = new WebSocket(opts.path ? `ws://127.0.0.1:${port}${opts.path}` : url(), { headers });
  open.push(ws);
  const messages: Array<Record<string, unknown>> = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  const rejected = new Promise<{ status?: number; error?: string }>((resolve) => {
    ws.once("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
    ws.once("error", (err) => resolve({ error: err.message }));
  });
  return { ws, messages, opened, closed, rejected };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function signedIn(sessionId = "sess-1", userId = "user-1") {
  state.sessions.set(sessionId, { userId });
  return sessionId;
}

describe("WebSocket gateway — handshake", () => {
  it("refuses a connection with no session cookie (401)", async () => {
    expect((await connect({ origin: ORIGIN }).rejected).status).toBe(401);
  });

  it("refuses an unknown / expired session (401)", async () => {
    expect((await connect({ cookie: "not-a-session" }).rejected).status).toBe(401);
  });

  it("refuses a foreign Origin even with a valid session (403) — no cross-site WebSocket hijacking", async () => {
    expect((await connect({ cookie: signedIn(), origin: "https://evil.example" }).rejected).status).toBe(403);
  });

  it("refuses a connection with no Origin header at all (403)", async () => {
    expect((await connect({ cookie: signedIn(), origin: null }).rejected).status).toBe(403);
  });

  it("drops a connection to any other path", async () => {
    const c = connect({ cookie: signedIn(), path: "/admin" });
    expect((await c.rejected).error ?? "").toMatch(/socket hang up|ECONNRESET|Unexpected/i);
  });

  it("accepts a valid session + origin and says what the upstream connection state is", async () => {
    const c = connect({ cookie: signedIn() });
    await c.opened;
    await until(() => c.messages.length > 0);
    expect(c.messages[0]).toEqual({ type: "CONNECTION_CHANGED", status: "open" });
  });

  it(`caps concurrent sockets per user at ${MAX_SOCKETS_PER_USER} (429), without affecting other users`, async () => {
    const sid = signedIn("s-a", "heavy-user");
    const held = Array.from({ length: MAX_SOCKETS_PER_USER }, () => connect({ cookie: sid }));
    await Promise.all(held.map((h) => h.opened));
    expect((await connect({ cookie: sid }).rejected).status).toBe(429);

    const other = connect({ cookie: signedIn("s-b", "other-user") });
    await other.opened; // a different user is unaffected
  });
});

describe("WebSocket gateway — subscriptions", () => {
  it("subscribes, forwards ticks, unsubscribes, and cleans everything up when the socket closes", async () => {
    const c = connect({ cookie: signedIn() });
    await c.opened;
    c.ws.send(JSON.stringify({ type: "SUBSCRIBE_TICKS", symbol: "R_100" }));
    await until(() => state.subscribed.includes("R_100"));

    state.tickListeners.get("R_100")!({ symbol: "R_100", quote: 1234.5, epoch: 1700000000 });
    await until(() => c.messages.some((m) => m.type === "MARKET_TICK"));
    expect(c.messages.find((m) => m.type === "MARKET_TICK")).toMatchObject({ symbol: "R_100", quote: 1234.5, epoch: 1700000000 });

    c.ws.send(JSON.stringify({ type: "SUBSCRIBE_TICKS", symbol: "R_50" }));
    await until(() => state.subscribed.includes("R_50"));
    c.ws.send(JSON.stringify({ type: "UNSUBSCRIBE_TICKS", symbol: "R_100" }));
    await until(() => state.unsubscribed.includes("R_100"));

    c.ws.close();
    await c.closed;
    await until(() => state.unsubscribed.includes("R_50")); // nothing leaks upstream after disconnect
  });

  it("ignores a duplicate subscription and invalid symbols; malformed JSON does not kill the connection", async () => {
    const c = connect({ cookie: signedIn() });
    await c.opened;
    for (const m of [{ type: "SUBSCRIBE_TICKS", symbol: "R_100" }, { type: "SUBSCRIBE_TICKS", symbol: "R_100" }, { type: "SUBSCRIBE_TICKS", symbol: "bad symbol!" }, { type: "SUBSCRIBE_TICKS", symbol: "x".repeat(100) }, { type: "NOPE" }]) {
      c.ws.send(JSON.stringify(m));
    }
    c.ws.send("{this is not json");
    c.ws.send(JSON.stringify({ type: "SUBSCRIBE_TICKS", symbol: "R_25" }));
    await until(() => state.subscribed.includes("R_25"));
    expect(state.subscribed.filter((s) => s === "R_100")).toHaveLength(1);
    expect(state.subscribed).not.toContain("bad symbol!");
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  it(`refuses symbol subscription number ${MAX_TICK_SUBSCRIPTIONS + 1} on one socket (protects the shared Deriv budget)`, async () => {
    const c = connect({ cookie: signedIn() });
    await c.opened;
    // stay under the 20 msg/s limiter while still filling the cap
    for (let i = 0; i < MAX_TICK_SUBSCRIPTIONS; i++) {
      c.ws.send(JSON.stringify({ type: "SUBSCRIBE_TICKS", symbol: `SYM_${i}` }));
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 1100));
    }
    await until(() => state.subscribed.length === MAX_TICK_SUBSCRIPTIONS, 5000);
    c.ws.send(JSON.stringify({ type: "SUBSCRIBE_TICKS", symbol: "ONE_TOO_MANY" }));
    await until(() => c.messages.some((m) => m.type === "SUBSCRIPTION_REJECTED"));
    expect(state.subscribed).not.toContain("ONE_TOO_MANY");
  }, 15000);

  it("exposes the position cap as a documented constant", () => {
    expect(MAX_POSITION_SUBSCRIPTIONS).toBeLessThan(MAX_TICK_SUBSCRIPTIONS);
  });
});

describe("WebSocket gateway — abuse limits", () => {
  it(`closes a connection that sends a frame larger than ${MAX_MESSAGE_BYTES} bytes (1009 message too big)`, async () => {
    const c = connect({ cookie: signedIn() });
    await c.opened;
    c.ws.send("x".repeat(MAX_MESSAGE_BYTES + 1));
    expect((await c.closed).code).toBe(1009);
  });

  it("closes a connection that floods messages (1008 policy violation)", async () => {
    const c = connect({ cookie: signedIn() });
    await c.opened;
    for (let i = 0; i < 60; i++) c.ws.send(JSON.stringify({ type: "UNSUBSCRIBE_TICKS", symbol: "R_100" }));
    expect((await c.closed).code).toBe(1008);
  });
});

describe("WebSocket gateway — session lifecycle", () => {
  it("logging out closes that browser's socket immediately (4401), and leaves other sessions alone", async () => {
    const out = connect({ cookie: signedIn("sess-out", "u1") });
    const keep = connect({ cookie: signedIn("sess-keep", "u2") });
    await Promise.all([out.opened, keep.opened]);

    closeSocketsForSession("sess-out"); // what POST /api/auth/logout calls
    expect((await out.closed).code).toBe(CLOSE_SESSION_ENDED);
    await new Promise((r) => setTimeout(r, 150));
    expect(keep.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("a session revoked elsewhere (expired / user suspended) is cut off by the periodic re-validation", async () => {
    const sid = signedIn("sess-revoked", "u1");
    const c = connect({ cookie: sid });
    await c.opened;
    state.sessions.delete(sid); // e.g. the user was suspended, or the session expired
    const closed = await c.closed; // heartbeatMs is 60 ms in this test
    expect(closed.code).toBe(CLOSE_SESSION_ENDED);
  });

  it("a healthy session survives many heartbeats (ping/pong keeps it alive)", async () => {
    const c = connect({ cookie: signedIn("sess-healthy", "u1") });
    await c.opened;
    await new Promise((r) => setTimeout(r, 400)); // ~6 heartbeats
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });
});
