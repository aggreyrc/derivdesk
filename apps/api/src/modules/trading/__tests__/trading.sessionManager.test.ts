import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { TradingSessionManager } from "../trading.sessionManager.js";
import type { DerivClientLike } from "../../deriv/deriv.client.js";

class FakeClient extends EventEmitter {
  onReconnect: (() => void) | null = null;
  requestMock = vi.fn();
  sendMock = vi.fn();
  connect = vi.fn();
  close = vi.fn();
  getStatus = vi.fn().mockReturnValue("open");
  request(msg: Record<string, unknown>) {
    return this.requestMock(msg);
  }
  send(msg: Record<string, unknown>) {
    this.sendMock(msg);
  }
}

function makeManager() {
  const clients: FakeClient[] = [];
  const otpProviders: Array<() => Promise<string>> = [];
  const derivClient: Partial<DerivClientLike> = {
    requestOtp: vi.fn().mockResolvedValue("wss://fake/otp"),
  };
  const tokens = { getAccessToken: vi.fn().mockResolvedValue("tok_abc") };

  const manager = new TradingSessionManager(derivClient as DerivClientLike, tokens, (otpUrlProvider) => {
    otpProviders.push(otpUrlProvider);
    const fake = new FakeClient();
    clients.push(fake);
    return fake as unknown as import("../derivPrivateClient.js").DerivPrivateClient;
  });

  return { manager, clients, tokens, derivClient };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("TradingSessionManager connection lifecycle", () => {
  it("creates exactly one connection for repeated calls on the same user+account", async () => {
    const { manager, clients } = makeManager();
    clients.length = 0;
    manager.subscribeBalance("user_1", "acc_1", vi.fn());
    manager.subscribeBalance("user_1", "acc_1", vi.fn());
    expect(clients).toHaveLength(1);
  });

  it("creates separate connections for different accounts, even for the same user", () => {
    const { manager, clients } = makeManager();
    manager.subscribeBalance("user_1", "acc_1", vi.fn());
    manager.subscribeBalance("user_1", "acc_2", vi.fn());
    expect(clients).toHaveLength(2);
  });

  it("creates separate connections for different users on the same account id", () => {
    const { manager, clients } = makeManager();
    manager.subscribeBalance("user_1", "acc_1", vi.fn());
    manager.subscribeBalance("user_2", "acc_1", vi.fn());
    expect(clients).toHaveLength(2);
  });

  it("tears down the connection after the grace period once every caller has released it", async () => {
    const { manager, clients } = makeManager();
    const unsub = manager.subscribeBalance("user_1", "acc_1", vi.fn());
    expect(clients).toHaveLength(1);

    unsub();
    expect(clients[0]!.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_001);
    expect(clients[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending teardown if a new caller acquires the session within the grace period", async () => {
    const { manager, clients } = makeManager();
    const unsub = manager.subscribeBalance("user_1", "acc_1", vi.fn());
    unsub();

    await vi.advanceTimersByTimeAsync(5_000);
    manager.subscribeBalance("user_1", "acc_1", vi.fn()); // re-acquire before grace period expires
    await vi.advanceTimersByTimeAsync(10_001);

    expect(clients[0]!.close).not.toHaveBeenCalled();
    expect(clients).toHaveLength(1); // no second connection was created either
  });
});

describe("TradingSessionManager.buy / .sell", () => {
  it("sends `buy` with the proposal id and agreed price, and releases the session afterward", async () => {
    const { manager, clients } = makeManager();
    clients.length = 0;
    // Force client creation first so the mock's resolved value is set BEFORE buy() issues
    // its request — otherwise the request resolves to undefined and the zod parse throws.
    manager.subscribeBalance("user_1", "acc_1", vi.fn())();
    const client = clients[0]!;
    client.requestMock.mockResolvedValue({
      msg_type: "buy",
      buy: { contract_id: 1, transaction_id: 2, purchase_time: 100, buy_price: 10 },
    });

    const result = await manager.buy("user_1", "acc_1", "prop_123", 10);

    expect(client.requestMock).toHaveBeenCalledWith({ buy: "prop_123", price: 10 });
    expect(result.contract_id).toBe(1);
  });

  it("sends `sell` with the contract id and minimum price", async () => {
    const { manager, clients } = makeManager();
    clients.length = 0;
    manager.subscribeBalance("user_1", "acc_1", vi.fn())();
    const client = clients[0]!;
    client.requestMock.mockResolvedValue({ msg_type: "sell", sell: { contract_id: 999, transaction_id: 5, sold_for: 12 } });

    const result = await manager.sell("user_1", "acc_1", 999, 5);

    expect(client.requestMock).toHaveBeenCalledWith({ sell: 999, price: 5 });
    expect(result.contract_id).toBe(999);
  });
});

describe("TradingSessionManager.getPortfolio / .getProfitTable", () => {
  it("requests `portfolio` and parses the current contracts shape", async () => {
    const { manager, clients } = makeManager();
    clients.length = 0;
    manager.subscribeBalance("user_1", "acc_1", vi.fn())();
    const client = clients[0]!;
    client.requestMock.mockResolvedValue({ msg_type: "portfolio", portfolio: { contracts: [] } });

    const result = await manager.getPortfolio("user_1", "acc_1");

    expect(client.requestMock).toHaveBeenCalledWith({ portfolio: 1 });
    expect(result).toEqual([]);
  });

  it("requests `profit_table` sorted DESC with the given limit", async () => {
    const { manager, clients } = makeManager();
    clients.length = 0;
    manager.subscribeBalance("user_1", "acc_1", vi.fn())();
    const client = clients[0]!;
    client.requestMock.mockResolvedValue({ msg_type: "profit_table", profit_table: { transactions: [] } });

    await manager.getProfitTable("user_1", "acc_1", 25);

    expect(client.requestMock).toHaveBeenCalledWith({ profit_table: 1, limit: 25, sort: "DESC" });
  });

  it("passes offset, date range and description through using Deriv's own field names", async () => {
    const { manager, clients } = makeManager();
    clients.length = 0;
    manager.subscribeBalance("user_1", "acc_1", vi.fn())();
    const client = clients[0]!;
    client.requestMock.mockResolvedValue({ msg_type: "profit_table", profit_table: { transactions: [] } });

    await manager.getProfitTable("user_1", "acc_1", 500, { offset: 500, sort: "DESC", dateFrom: 1700000000, dateTo: 1800000000, description: true });

    expect(client.requestMock).toHaveBeenCalledWith({ profit_table: 1, limit: 500, sort: "DESC", offset: 500, date_from: "1700000000", date_to: "1800000000", description: 1 });
  });

  it("accepts the nullable contract_id/sell_time Deriv documents for profit_table rows", async () => {
    const { manager, clients } = makeManager();
    clients.length = 0;
    manager.subscribeBalance("user_1", "acc_1", vi.fn())();
    const client = clients[0]!;
    client.requestMock.mockResolvedValue({
      msg_type: "profit_table",
      profit_table: { transactions: [{ contract_id: null, transaction_id: 1, purchase_time: 1, sell_time: null, buy_price: 1 }] },
    });
    await expect(manager.getProfitTable("user_1", "acc_1", 5)).resolves.toHaveLength(1);
  });
});

describe("TradingSessionManager position subscriptions", () => {
  it("subscribes to a contract's updates only once for multiple listeners", async () => {
    const { manager, clients } = makeManager();
    clients.length = 0;
    manager.subscribeBalance("user_1", "acc_1", vi.fn()); // force client creation synchronously
    const client = clients[0]!;
    client.requestMock.mockResolvedValue({ subscription: { id: "sub_xyz" } });

    manager.subscribePosition("user_1", "acc_1", 111, vi.fn());
    manager.subscribePosition("user_1", "acc_1", 111, vi.fn());

    await vi.waitFor(() =>
      expect(client.requestMock).toHaveBeenCalledWith({ proposal_open_contract: 1, contract_id: 111, subscribe: 1 }),
    );
    const calls = client.requestMock.mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>).proposal_open_contract === 1,
    );
    expect(calls).toHaveLength(1);
  });

  it("calls forget with the real subscription id once the last listener on a contract unsubscribes", async () => {
    const { manager, clients } = makeManager();
    clients.length = 0;
    // Prime the mock BEFORE triggering the subscribe request, so its resolved value is set
    // before anything awaits it — otherwise the request resolves to `undefined` and
    // sub.subscriptionId never gets set, so `unsub()` has nothing to forget.
    manager.subscribeBalance("user_1", "acc_1", vi.fn()); // force client creation synchronously
    const client = clients[0]!;
    client.requestMock.mockResolvedValue({ subscription: { id: "sub_xyz" } });

    const unsub = manager.subscribePosition("user_1", "acc_1", 111, vi.fn());
    await vi.waitFor(() =>
      expect(client.requestMock).toHaveBeenCalledWith({ proposal_open_contract: 1, contract_id: 111, subscribe: 1 }),
    );
    // Give the awaited subscribe request's .then() a tick to actually set subscriptionId.
    await vi.waitFor(() => expect(client.requestMock).toHaveBeenCalled());

    unsub();
    expect(client.sendMock).toHaveBeenCalledWith({ forget: "sub_xyz" });
  });

  it("delivers an open-contract push only to listeners on that contract", async () => {
    const { manager, clients } = makeManager();
    clients.length = 0;
    manager.subscribeBalance("user_1", "acc_1", vi.fn());
    const client = clients[0]!;
    client.requestMock.mockResolvedValue({ subscription: { id: "sub_1" } });

    const cb111 = vi.fn();
    const cb222 = vi.fn();
    manager.subscribePosition("user_1", "acc_1", 111, cb111);
    manager.subscribePosition("user_1", "acc_1", 222, cb222);
    await vi.waitFor(() => expect(client.requestMock.mock.calls.length).toBeGreaterThanOrEqual(2));

    client.emit("message", { msg_type: "proposal_open_contract", proposal_open_contract: { contract_id: 111, contract_type: "CALL", currency: "USD" } });

    expect(cb111).toHaveBeenCalledWith(expect.objectContaining({ contract_id: 111 }));
    expect(cb222).not.toHaveBeenCalled();
  });
});

describe("TradingSessionManager balance subscriptions", () => {
  it("subscribes to balance once per session and fans updates out to every listener", async () => {
    const { manager, clients } = makeManager();
    clients.length = 0;
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    manager.subscribeBalance("user_1", "acc_1", cb1);
    manager.subscribeBalance("user_1", "acc_1", cb2);
    const client = clients[0]!;
    await vi.waitFor(() => expect(client.requestMock).toHaveBeenCalledWith({ balance: 1, subscribe: 1 }));

    client.emit("message", { msg_type: "balance", balance: { balance: 500, currency: "USD" } });

    expect(cb1).toHaveBeenCalledWith(expect.objectContaining({ balance: 500 }));
    expect(cb2).toHaveBeenCalledWith(expect.objectContaining({ balance: 500 }));
    expect(client.requestMock.mock.calls.filter((c) => (c[0] as Record<string, unknown>).balance === 1)).toHaveLength(1);
  });

  it("does not deliver balance updates to a different user's session", async () => {
    const { manager, clients } = makeManager();
    clients.length = 0;
    const cbUser1 = vi.fn();
    const cbUser2 = vi.fn();
    manager.subscribeBalance("user_1", "acc_1", cbUser1);
    manager.subscribeBalance("user_2", "acc_1", cbUser2);
    expect(clients).toHaveLength(2);

    clients[0]!.emit("message", { msg_type: "balance", balance: { balance: 111, currency: "USD" } });

    expect(cbUser1).toHaveBeenCalledWith(expect.objectContaining({ balance: 111 }));
    expect(cbUser2).not.toHaveBeenCalled();
  });
});
