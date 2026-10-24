import { describe, expect, it } from "vitest";
import { BuyGuard } from "../buyGuard.js";

describe("BuyGuard", () => {
  it("allows a first purchase", () => {
    const g = new BuyGuard();
    expect(() => g.begin("u1", "p1")).not.toThrow();
  });

  it("refuses a second concurrent buy by the same user (double-click)", () => {
    const g = new BuyGuard();
    g.begin("u1", "p1");
    expect(() => g.begin("u1", "p2")).toThrowError(expect.objectContaining({ status: 409, code: "BuyInProgress" }));
  });

  it("does not block a different user while one is in flight", () => {
    const g = new BuyGuard();
    g.begin("u1", "p1");
    expect(() => g.begin("u2", "p1")).not.toThrow();
  });

  it("releases the in-flight lock after a failed buy and keeps the quote reusable", () => {
    const g = new BuyGuard();
    g.begin("u1", "p1");
    g.finish("u1", "p1", "failed");
    expect(() => g.begin("u1", "p1")).not.toThrow();
  });

  it("refuses to reuse a quote that already produced a purchase", () => {
    const g = new BuyGuard();
    g.begin("u1", "p1");
    g.finish("u1", "p1", "bought");
    expect(() => g.begin("u1", "p1")).toThrowError(expect.objectContaining({ status: 409, code: "DuplicateBuy" }));
    // …but a fresh quote is fine
    expect(() => g.begin("u1", "p2")).not.toThrow();
  });

  it("forgets purchased quotes after the TTL", () => {
    let t = 0;
    const g = new BuyGuard(1000, () => t);
    g.begin("u1", "p1");
    g.finish("u1", "p1", "bought");
    t = 1001;
    expect(() => g.begin("u1", "p1")).not.toThrow();
  });
});
