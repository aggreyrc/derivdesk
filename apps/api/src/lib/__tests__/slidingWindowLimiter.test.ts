import { describe, expect, it, vi } from "vitest";
import { SlidingWindowLimiter } from "../slidingWindowLimiter.js";

describe("SlidingWindowLimiter", () => {
  it("runs work immediately while under the limit", async () => {
    const limiter = new SlidingWindowLimiter(3, 1000);
    const results = await Promise.all([limiter.schedule(async () => 1), limiter.schedule(async () => 2), limiter.schedule(async () => 3)]);
    expect(results).toEqual([1, 2, 3]);
  });

  it("queues work past the limit and releases it as the window slides", async () => {
    vi.useFakeTimers();
    const now = { t: 0 };
    const limiter = new SlidingWindowLimiter(2, 1000, () => now.t);

    const order: number[] = [];
    const p1 = limiter.schedule(async () => order.push(1));
    const p2 = limiter.schedule(async () => order.push(2));
    const p3 = limiter.schedule(async () => order.push(3)); // over budget — must wait

    await Promise.resolve();
    expect(order).toEqual([1, 2]);
    expect(limiter.queueLength).toBe(1);

    now.t = 1001; // first two timestamps have now aged out of the 1000ms window
    await vi.advanceTimersByTimeAsync(1001);
    await p3;
    expect(order).toEqual([1, 2, 3]);

    await Promise.all([p1, p2]);
    vi.useRealTimers();
  });

  it("serves requests in FIFO order", async () => {
    vi.useFakeTimers();
    const now = { t: 0 };
    const limiter = new SlidingWindowLimiter(1, 100, () => now.t);
    const order: number[] = [];

    limiter.schedule(async () => order.push(1));
    const p2 = limiter.schedule(async () => order.push(2));
    const p3 = limiter.schedule(async () => order.push(3));

    now.t = 101;
    await vi.advanceTimersByTimeAsync(101);
    now.t = 202;
    await vi.advanceTimersByTimeAsync(101);
    await Promise.all([p2, p3]);

    expect(order).toEqual([1, 2, 3]);
    vi.useRealTimers();
  });
});
