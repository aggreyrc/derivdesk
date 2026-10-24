// Abuse limits for the browser <-> gateway socket. Every limit here protects a SHARED resource:
// the single Deriv public connection and its rate-limit budget (docs/phase1-architecture.md §2),
// process memory, and the CPU spent parsing frames.

/** Largest frame the gateway will accept. Real client messages are ~60 bytes; the `ws` default
 *  (100 MiB) would let any authenticated user make the server buffer and JSON.parse that. */
export const MAX_MESSAGE_BYTES = 1024;

export const MAX_TICK_SUBSCRIPTIONS = 40;
export const MAX_POSITION_SUBSCRIPTIONS = 20;

/** Sustained message rate before the connection is dropped. */
export const MAX_MESSAGES_PER_SECOND = 20;

export const HEARTBEAT_MS = 30_000;

export class MessageRateLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly maxPerSecond = MAX_MESSAGES_PER_SECOND,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records one message; returns false when the connection is over its budget. */
  allow(): boolean {
    const t = this.now();
    const cutoff = t - 1000;
    this.stamps = this.stamps.filter((s) => s > cutoff);
    this.stamps.push(t);
    return this.stamps.length <= this.maxPerSecond;
  }
}

export function isValidContractId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
