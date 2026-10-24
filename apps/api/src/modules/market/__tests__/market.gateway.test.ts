import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { MarketDataGateway } from "../market.gateway.js";
import type { DerivPublicClient } from "../derivPublicClient.js";

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

function makeGateway() {
  const fake = new FakeClient();
  const gateway = new MarketDataGateway("wss://fake", () => fake as unknown as DerivPublicClient);
  return { gateway, fake };
}

describe("MarketDataGateway.getActiveSymbols", () => {
  it("parses the current (non-legacy) field names and caches the result", async () => {
    const { gateway, fake } = makeGateway();
    fake.requestMock.mockResolvedValue({
      msg_type: "active_symbols",
      active_symbols: [{ underlying_symbol: "R_100", market: "synthetic_index", pip_size: 0.01 }],
    });

    const first = await gateway.getActiveSymbols();
    const second = await gateway.getActiveSymbols();

    expect(first[0]!.underlying_symbol).toBe("R_100");
    expect(second).toBe(first); // cache hit — no second request
    expect(fake.requestMock).toHaveBeenCalledTimes(1);
  });

  it("throws rather than silently returning malformed data when Deriv's shape doesn't match", async () => {
    const { gateway, fake } = makeGateway();
    fake.requestMock.mockResolvedValue({ msg_type: "active_symbols", active_symbols: [{ symbol: "legacy-field-name-only" }] });
    await expect(gateway.getActiveSymbols()).rejects.toThrow(/Unexpected response/);
  });
});

describe("MarketDataGateway.getCandles", () => {
  it("requests candle style with subscribe:0 (one-shot, not a stream)", async () => {
    const { gateway, fake } = makeGateway();
    fake.requestMock.mockResolvedValue({ msg_type: "candles", candles: [{ epoch: 1, open: 1, high: 2, low: 0.5, close: 1.5 }], pip_size: 2 });

    const result = await gateway.getCandles("R_100", 60, 200);

    expect(fake.requestMock).toHaveBeenCalledWith(expect.objectContaining({ ticks_history: "R_100", style: "candles", subscribe: 0 }));
    expect(result.candles).toHaveLength(1);
    expect(result.pipSize).toBe(2);
  });
});

describe("MarketDataGateway tick subscriptions", () => {
  it("subscribes to Deriv only once for multiple listeners on the same symbol", async () => {
    const { gateway, fake } = makeGateway();
    fake.requestMock.mockResolvedValue({ subscription: { id: "sub_1" } });

    gateway.subscribeTicks("R_100", vi.fn());
    gateway.subscribeTicks("R_100", vi.fn());
    await vi.waitFor(() => expect(fake.requestMock).toHaveBeenCalledTimes(1));
    expect(fake.requestMock).toHaveBeenCalledWith(expect.objectContaining({ ticks: "R_100", subscribe: 1 }));
  });

  it("fans a single Deriv tick out to every listener on that symbol", async () => {
    const { gateway, fake } = makeGateway();
    fake.requestMock.mockResolvedValue({ subscription: { id: "sub_1" } });
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    gateway.subscribeTicks("R_100", cb1);
    gateway.subscribeTicks("R_100", cb2);
    await vi.waitFor(() => expect(fake.requestMock).toHaveBeenCalledTimes(1));

    fake.emit("message", { msg_type: "tick", tick: { symbol: "R_100", quote: 100.5, epoch: 1 } });

    expect(cb1).toHaveBeenCalledWith(expect.objectContaining({ quote: 100.5 }));
    expect(cb2).toHaveBeenCalledWith(expect.objectContaining({ quote: 100.5 }));
  });

  it("does NOT call forget while at least one listener remains", async () => {
    const { gateway, fake } = makeGateway();
    fake.requestMock.mockResolvedValue({ subscription: { id: "sub_1" } });
    const cb1 = vi.fn();
    const unsub1 = gateway.subscribeTicks("R_100", cb1);
    gateway.subscribeTicks("R_100", vi.fn());
    await vi.waitFor(() => expect(fake.requestMock).toHaveBeenCalledTimes(1));

    unsub1();
    expect(fake.sendMock).not.toHaveBeenCalled();
  });

  it("calls forget with the real subscription id once the last listener unsubscribes", async () => {
    const { gateway, fake } = makeGateway();
    fake.requestMock.mockResolvedValue({ subscription: { id: "sub_xyz" } });
    const unsub = gateway.subscribeTicks("R_100", vi.fn());
    await vi.waitFor(() => expect(fake.requestMock).toHaveBeenCalledTimes(1));

    unsub();
    expect(fake.sendMock).toHaveBeenCalledWith({ forget: "sub_xyz" });
  });

  it("does not deliver a tick for a symbol nobody is listening to anymore", async () => {
    const { gateway, fake } = makeGateway();
    fake.requestMock.mockResolvedValue({ subscription: { id: "sub_1" } });
    const cb = vi.fn();
    const unsub = gateway.subscribeTicks("R_100", cb);
    await vi.waitFor(() => expect(fake.requestMock).toHaveBeenCalledTimes(1));
    unsub();

    fake.emit("message", { msg_type: "tick", tick: { symbol: "R_100", quote: 1, epoch: 1 } });
    expect(cb).not.toHaveBeenCalled();
  });

  it("re-subscribes every active symbol after a reconnect", async () => {
    const { gateway, fake } = makeGateway();
    fake.requestMock.mockResolvedValue({ subscription: { id: "sub_1" } });
    gateway.subscribeTicks("R_100", vi.fn());
    await vi.waitFor(() => expect(fake.requestMock).toHaveBeenCalledTimes(1));

    fake.requestMock.mockResolvedValue({ subscription: { id: "sub_2" } });
    fake.onReconnect?.();
    await vi.waitFor(() => expect(fake.requestMock).toHaveBeenCalledTimes(2));
    expect(fake.requestMock).toHaveBeenLastCalledWith(expect.objectContaining({ ticks: "R_100", subscribe: 1 }));
  });
});

describe("MarketDataGateway.getContractsFor", () => {
  it("parses the current (non-legacy) contracts_for shape", async () => {
    const { gateway, fake } = makeGateway();
    fake.requestMock.mockResolvedValue({
      msg_type: "contracts_for",
      contracts_for: {
        available: [
          { contract_type: "CALL", contract_category: "callput", underlying_symbol: "R_100", market: "synthetic_index" },
        ],
        hit_count: 1,
      },
    });

    const result = await gateway.getContractsFor("R_100");

    expect(fake.requestMock).toHaveBeenCalledWith({ contracts_for: "R_100" });
    expect(result).toHaveLength(1);
    expect(result[0]!.contract_type).toBe("CALL");
  });

  it("throws rather than silently returning malformed data", async () => {
    const { gateway, fake } = makeGateway();
    fake.requestMock.mockResolvedValue({ msg_type: "contracts_for", contracts_for: { available: [{ contract_type: "NOT_A_TYPE" }] } });
    await expect(gateway.getContractsFor("R_100")).rejects.toThrow(/Unexpected response/);
  });
});

describe("MarketDataGateway.getProposal", () => {
  it("only requires `id` on the response, per the current (non-legacy) shape", async () => {
    const { gateway, fake } = makeGateway();
    fake.requestMock.mockResolvedValue({ msg_type: "proposal", proposal: { id: "prop_123" } });

    const result = await gateway.getProposal({ contract_type: "CALL", underlying_symbol: "R_100", currency: "USD", amount: 10, basis: "stake", duration: 5, duration_unit: "t" });

    expect(fake.requestMock).toHaveBeenCalledWith(expect.objectContaining({ proposal: 1, contract_type: "CALL" }));
    expect(result.id).toBe("prop_123");
  });

  it("rejects a response missing even `id`", async () => {
    const { gateway, fake } = makeGateway();
    fake.requestMock.mockResolvedValue({ msg_type: "proposal", proposal: { ask_price: 10 } });
    await expect(gateway.getProposal({ contract_type: "CALL", underlying_symbol: "R_100", currency: "USD" })).rejects.toThrow(/Unexpected response/);
  });
});

describe("MarketDataGateway status", () => {
  it("re-emits the underlying client's connection status", () => {
    const { gateway, fake } = makeGateway();
    const onStatus = vi.fn();
    gateway.on("status", onStatus);
    fake.emit("status", "reconnecting");
    expect(onStatus).toHaveBeenCalledWith("reconnecting");
  });
});
