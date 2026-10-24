// Paces async work to stay under a shared "N per rolling window" budget — built for
// Deriv's grouped WS rate limits (see docs/phase1-architecture.md §2): e.g. active_symbols +
// ticks + ticks_history together draw on ONE 220-per-minute budget for this whole backend
// process, not 220 each. Requests queue (FIFO) and run as capacity frees up, rather than
// bursting and hitting a 429/rate-limit error from Deriv.
export class SlidingWindowLimiter {
  private timestamps: number[] = [];
  private queue: Array<() => void> = [];
  private draining = false;

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    return fn();
  }

  get queueLength(): number {
    return this.queue.length;
  }

  private acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  private drain() {
    if (this.draining) return;
    this.draining = true;
    this.pump();
  }

  private pump() {
    const cutoff = this.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);

    while (this.queue.length > 0 && this.timestamps.length < this.maxPerWindow) {
      const resolve = this.queue.shift()!;
      this.timestamps.push(this.now());
      resolve();
    }

    if (this.queue.length === 0) {
      this.draining = false;
      return;
    }

    // Next slot frees when the oldest timestamp in the window ages out.
    const oldest = this.timestamps[0]!;
    const delay = Math.max(1, oldest + this.windowMs - this.now());
    setTimeout(() => this.pump(), delay);
  }
}
