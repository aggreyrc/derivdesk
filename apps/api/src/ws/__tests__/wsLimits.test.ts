import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageRateLimiter, isValidContractId } from "../wsLimits.js";
import { CLOSE_SESSION_ENDED, MAX_SOCKETS_PER_USER, _resetSocketRegistryForTests, closeSocketsForSession, countSocketsForUser, registerSocket } from "../socketRegistry.js";

describe("MessageRateLimiter", () => {
  it("allows a burst up to the cap per second, then refuses, then recovers", () => {
    let t = 0;
    const r = new MessageRateLimiter(3, () => t);
    expect([r.allow(), r.allow(), r.allow()]).toEqual([true, true, true]);
    expect(r.allow()).toBe(false);
    t = 1001;
    expect(r.allow()).toBe(true);
  });
});

describe("isValidContractId", () => {
  it.each([[1, true], [123456789, true], [0, false], [-5, false], [1.5, false], [NaN, false], [Infinity, false], [2 ** 60, false], ["12", false], [null, false]])(
    "%s -> %s",
    (v, ok) => expect(isValidContractId(v)).toBe(ok),
  );
});

describe("socket registry", () => {
  beforeEach(() => _resetSocketRegistryForTests());

  it("closes every socket of a signed-out session, and only those", () => {
    const a = { close: vi.fn() };
    const b = { close: vi.fn() };
    const other = { close: vi.fn() };
    registerSocket("u1", "s1", a);
    registerSocket("u1", "s1", b);
    registerSocket("u1", "s2", other);
    closeSocketsForSession("s1");
    expect(a.close).toHaveBeenCalledWith(CLOSE_SESSION_ENDED, expect.any(String));
    expect(b.close).toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
    expect(countSocketsForUser("u1")).toBe(1);
  });

  it("counts per user and decrements on unregister", () => {
    const offs = Array.from({ length: MAX_SOCKETS_PER_USER }, () => registerSocket("u1", "s1", { close: vi.fn() }));
    expect(countSocketsForUser("u1")).toBe(MAX_SOCKETS_PER_USER);
    expect(countSocketsForUser("u2")).toBe(0);
    offs[0]!();
    expect(countSocketsForUser("u1")).toBe(MAX_SOCKETS_PER_USER - 1);
  });
});
