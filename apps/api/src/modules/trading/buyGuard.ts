import { HttpError } from "../../middleware/errorHandler.js";

// App-level protection against an accidental DOUBLE purchase — a double-click, a retry after a
// slow response, two tabs. This is our own policy, not a claim about Deriv's behaviour:
//   1. one buy in flight per user at a time, and
//   2. a proposal id that already produced a purchase is not accepted again for a while; buying
//      the same thing twice must be a deliberate act (request a fresh quote), never an accident.
// Process-local by design (single API instance today). With several instances this becomes
// best-effort per instance; it never blocks a legitimate first purchase.
export class BuyGuard {
  private inFlight = new Set<string>();
  private purchased = new Map<string, number>(); // `${userId}:${proposalId}` -> purchase time

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws 409 if this buy must not proceed. On success the caller MUST call finish(). */
  begin(userId: string, proposalId: string): void {
    this.prune();
    if (this.purchased.has(`${userId}:${proposalId}`)) {
      throw new HttpError(409, "DuplicateBuy", "This quote has already been used to place a trade. Request a new price if you want to buy again.");
    }
    if (this.inFlight.has(userId)) {
      throw new HttpError(409, "BuyInProgress", "A purchase is already being processed. Check your portfolio before trying again.");
    }
    this.inFlight.add(userId);
  }

  finish(userId: string, proposalId: string, outcome: "bought" | "failed"): void {
    this.inFlight.delete(userId);
    if (outcome === "bought") this.purchased.set(`${userId}:${proposalId}`, this.now());
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, at] of this.purchased) if (at < cutoff) this.purchased.delete(key);
  }
}

export const buyGuard = new BuyGuard();
