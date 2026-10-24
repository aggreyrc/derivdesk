import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { DerivPrivateClient } from "../derivPrivateClient.js";

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  sent: string[] = [];

  constructor() {
    super();
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
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

describe("DerivPrivateClient", () => {
  it("requests a fresh OTP url and connects to it", async () => {
    const otpUrlProvider = vi.fn().mockResolvedValue("wss://fake/otp-1");
    const getAccessToken = vi.fn().mockResolvedValue("tok_abc");
    const client = new DerivPrivateClient(otpUrlProvider, getAccessToken, () => new FakeSocket() as unknown as import("ws").default);

    client.connect();
    await vi.waitFor(() => expect(otpUrlProvider).toHaveBeenCalledTimes(1));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("sends a defensive `authorize` after connecting and records an accepted outcome", async () => {
    const otpUrlProvider = vi.fn().mockResolvedValue("wss://fake/otp-1");
    const getAccessToken = vi.fn().mockResolvedValue("tok_abc");
    const client = new DerivPrivateClient(otpUrlProvider, getAccessToken, () => new FakeSocket() as unknown as import("ws").default);

    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const sock = FakeSocket.instances[0]!;
    sock.serverOpen();

    await vi.waitFor(() => expect(sock.sent.length).toBeGreaterThan(0));
    const sent = lastSent(sock);
    expect(sent.authorize).toBe("tok_abc");

    sock.serverSends({ msg_type: "authorize", authorize: { loginid: "CR123" }, req_id: sent.req_id });
    await vi.waitFor(() => expect(client.lastAuthorizeOutcome).toBe("accepted"));
  });

  it("records a rejected outcome WITHOUT closing the connection when authorize fails", async () => {
    const otpUrlProvider = vi.fn().mockResolvedValue("wss://fake/otp-1");
    const getAccessToken = vi.fn().mockResolvedValue("tok_abc");
    const client = new DerivPrivateClient(otpUrlProvider, getAccessToken, () => new FakeSocket() as unknown as import("ws").default);

    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const sock = FakeSocket.instances[0]!;
    sock.serverOpen();

    await vi.waitFor(() => expect(sock.sent.length).toBeGreaterThan(0));
    const sent = lastSent(sock);
    sock.serverSends({ error: { code: "AuthorizationRequired", message: "not needed on OTP connections" }, echo_req: { req_id: sent.req_id } });

    await vi.waitFor(() => expect(client.lastAuthorizeOutcome).toBe("rejected"));
    expect(client.getStatus()).toBe("open");
  });

  it("requests a fresh OTP url on every reconnect, never caching it", async () => {
    const otpUrlProvider = vi.fn().mockResolvedValue("wss://fake/otp-1");
    const getAccessToken = vi.fn().mockResolvedValue("tok_abc");
    const client = new DerivPrivateClient(otpUrlProvider, getAccessToken, () => new FakeSocket() as unknown as import("ws").default);

    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    FakeSocket.instances[0]!.serverOpen();
    expect(otpUrlProvider).toHaveBeenCalledTimes(1);

    FakeSocket.instances[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(1600);
    await vi.waitFor(() => expect(otpUrlProvider).toHaveBeenCalledTimes(2));
    expect(FakeSocket.instances).toHaveLength(2);
  });
});
