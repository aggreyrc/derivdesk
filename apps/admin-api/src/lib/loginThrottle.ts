// Failed-login throttling, layered on top of the per-IP request limiter (which alone cannot stop
// a slow, distributed guess at ONE account, nor penalises a single IP hammering many accounts
// below the request cap). Two counters per attempt:
//   - email+ip : tight  — blunts one client working on one account
//   - email    : looser — blunts many IPs working on one account
// The per-email cap is also a (temporary, 15-minute) lock-out lever against the account owner;
// it is kept deliberately high so that is impractical to abuse, and documented in
// docs/security-review.md. In-memory and per-process: with several API instances the effective
// cap is multiplied by the instance count, which still bounds the attack.

export class FailureThrottle {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  recordFailure(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) {
      // Bounded memory: drop the oldest-inserted keys rather than grow without limit.
      const overflow = this.hits.size - this.maxKeys;
      let i = 0;
      for (const k of this.hits.keys()) {
        if (i++ >= overflow) break;
        this.hits.delete(k);
      }
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }
}

const WINDOW_MS = 15 * 60_000;

export class LoginThrottle {
  constructor(
    private readonly perEmailIp = new FailureThrottle(5, WINDOW_MS),
    private readonly perEmail = new FailureThrottle(20, WINDOW_MS),
  ) {}

  isBlocked(email: string, ip: string | undefined): boolean {
    return this.perEmailIp.isBlocked(`${email}|${ip ?? "?"}`) || this.perEmail.isBlocked(email);
  }

  recordFailure(email: string, ip: string | undefined): void {
    this.perEmailIp.recordFailure(`${email}|${ip ?? "?"}`);
    this.perEmail.recordFailure(email);
  }

  /** Success clears only the caller's own pair — an attacker who guesses wrong 19 times and
   *  then logs into their OWN account must not reset the counter for the victim's email. */
  recordSuccess(email: string, ip: string | undefined): void {
    this.perEmailIp.reset(`${email}|${ip ?? "?"}`);
  }
}

export const loginThrottle = new LoginThrottle();
