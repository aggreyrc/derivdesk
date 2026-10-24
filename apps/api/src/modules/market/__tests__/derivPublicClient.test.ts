import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { DerivPublicClient } from "../derivPublicClient.js";

// A minimal fake of the `ws` WebSocket surface the client actually uses.
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  closed = false;

  constructor() {
    super();
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.emit("close");
  }

  serverOpen() {
    this.emit("open");
  }

  serverSends(msg: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

function lastSent(sock: FakeSocket): Record<string, unknown> {
  return JSON.parse(sock.sent[sock.sent.length - 1]!);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("DerivPublicClient", () => {
  it("correlates a response by top-level req_id and resolves the request", async () => {
    const client = new DerivPublicClient("wss://fake", () => new FakeSocket() as unknown as import("ws").default);
    client.connect();
    const sock = FakeSocket.instances[0]!;
    sock.serverOpen();

    const promise = client.request({ active_symbols: "brief" });
    const sent = lastSent(sock);
    expect(sent.req_id).toBeTypeOf("number");

    sock.serverSends({ msg_type: "active_symbols", active_symbols: [], req_id: sent.req_id });
    await expect(promise).resolves.toMatchObject({ msg_type: "active_symbols" });
  });

  it("correlates via echo_req.req_id when the response nests it there instead", async () => {
    const client = new DerivPublicClient("wss://fake", () => new FakeSocket() as unknown as import("ws").default);
    client.connect();
    const sock = FakeSocket.instances[0]!;
    sock.serverOpen();

    const promise = client.request({ ticks_history: "R_100", end: "latest" });
    const sent = lastSent(sock);

    sock.serverSends({ msg_type: "history", history: { prices: [], times: [] }, echo_req: { req_id: sent.req_id } });
    await expect(promise).resolves.toMatchObject({ msg_type: "history" });
  });

  it("rejects the request when Deriv returns an error frame, without crashing the client", async () => {
    const client = new DerivPublicClient("wss://fake", () => new FakeSocket() as unknown as import("ws").default);
    client.connect();
    const sock = FakeSocket.instances[0]!;
    sock.serverOpen();

    const promise = client.request({ ticks_history: "NOT_A_SYMBOL", end: "latest" });
    const sent = lastSent(sock);
    sock.serverSends({ error: { code: "InvalidSymbol", message: "bad symbol" }, echo_req: { req_id: sent.req_id } });

    await expect(promise).rejects.toThrow(/bad symbol/);
  });

  it("times out a request that never gets a response, instead of hanging forever", async () => {
    const client = new DerivPublicClient("wss://fake", () => new FakeSocket() as unknown as import("ws").default);
    client.connect();
    FakeSocket.instances[0]!.serverOpen();

    const promise = client.request({ active_symbols: "brief" });
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(15_001);
    await assertion;
  });

  it("emits every inbound frame as a message event, including unsolicited subscription pushes", async () => {
    const client = new DerivPublicClient("wss://fake", () => new FakeSocket() as unknown as import("ws").default);
    const onMessage = vi.fn();
    client.on("message", onMessage);
    client.connect();
    FakeSocket.instances[0]!.serverOpen();

    FakeSocket.instances[0]!.serverSends({ msg_type: "tick", tick: { symbol: "R_100", quote: 123.45, epoch: 1 } });
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ msg_type: "tick" }));
  });

  it("reconnects with backoff after a disconnect and calls onReconnect so subscriptions can be restored", async () => {
    const client = new DerivPublicClient("wss://fake", () => new FakeSocket() as unknown as import("ws").default);
    const onReconnect = vi.fn();
    client.onReconnect = onReconnect;
    client.connect();
    FakeSocket.instances[0]!.serverOpen();
    expect(onReconnect).toHaveBeenCalledTimes(1); // called on the initial connect too

    FakeSocket.instances[0]!.emit("close");
    expect(client.getStatus()).toBe("reconnecting");
    expect(FakeSocket.instances).toHaveLength(1); // hasn't reconnected yet — backoff pending

    await vi.advanceTimersByTimeAsync(1600); // first backoff is ~1s + jitter
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]!.serverOpen();
    expect(onReconnect).toHaveBeenCalledTimes(2);
    expect(client.getStatus()).toBe("open");
  });

  it("rejects in-flight requests immediately on disconnect rather than waiting for the timeout", async () => {
    const client = new DerivPublicClient("wss://fake", () => new FakeSocket() as unknown as import("ws").default);
    client.connect();
    FakeSocket.instances[0]!.serverOpen();

    const promise = client.request({ active_symbols: "brief" });
    FakeSocket.instances[0]!.emit("close");

    await expect(promise).rejects.toThrow(/lost/);
  });

  it("does not reconnect after an explicit close()", async () => {
    const client = new DerivPublicClient("wss://fake", () => new FakeSocket() as unknown as import("ws").default);
    client.connect();
    FakeSocket.instances[0]!.serverOpen();

    client.close();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(client.getStatus()).toBe("closed");
  });

  it("sends a ping on the documented 30s interval", async () => {
    const client = new DerivPublicClient("wss://fake", () => new FakeSocket() as unknown as import("ws").default);
    client.connect();
    const sock = FakeSocket.instances[0]!;
    sock.serverOpen();
    sock.sent = [];

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sock.sent.some((s) => JSON.parse(s).ping === 1)).toBe(true);
  });
});
