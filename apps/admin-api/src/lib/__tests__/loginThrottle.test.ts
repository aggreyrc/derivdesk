import { describe, expect, it } from "vitest";
import { FailureThrottle, LoginThrottle } from "../loginThrottle.js";

describe("FailureThrottle", () => {
  it("blocks after max failures inside the window and recovers after it", () => {
    let t = 0;
    const f = new FailureThrottle(3, 1000, () => t);
    f.recordFailure("k");
    f.recordFailure("k");
    expect(f.isBlocked("k")).toBe(false);
    f.recordFailure("k");
    expect(f.isBlocked("k")).toBe(true);
    t = 1001;
    expect(f.isBlocked("k")).toBe(false);
  });

  it("keeps memory bounded", () => {
    const f = new FailureThrottle(3, 60_000, () => 0, 5);
    for (let i = 0; i < 50; i++) f.recordFailure(`k${i}`);
    // the newest keys survive, the oldest were evicted
    expect(f.isBlocked("k0")).toBe(false);
  });
});

describe("LoginThrottle", () => {
  it("blocks one client after 5 failures on one account, without blocking another client", () => {
    const l = new LoginThrottle();
    for (let i = 0; i < 5; i++) l.recordFailure("a@x.com", "1.1.1.1");
    expect(l.isBlocked("a@x.com", "1.1.1.1")).toBe(true);
    expect(l.isBlocked("a@x.com", "2.2.2.2")).toBe(false);
    expect(l.isBlocked("b@x.com", "1.1.1.1")).toBe(false);
  });

  it("blocks everyone on an account after 20 failures from many IPs", () => {
    const l = new LoginThrottle();
    for (let i = 0; i < 20; i++) l.recordFailure("a@x.com", `10.0.0.${i}`);
    expect(l.isBlocked("a@x.com", "9.9.9.9")).toBe(true);
  });

  it("a success clears only the caller's own pair, not the account-wide counter", () => {
    const l = new LoginThrottle();
    for (let i = 0; i < 19; i++) l.recordFailure("v@x.com", `10.0.0.${i}`);
    l.recordSuccess("v@x.com", "6.6.6.6"); // attacker logs into their own account elsewhere — different email
    l.recordFailure("v@x.com", "10.0.1.1");
    expect(l.isBlocked("v@x.com", "7.7.7.7")).toBe(true);
  });
});
