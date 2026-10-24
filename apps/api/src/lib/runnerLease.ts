// A leader lease stored in Postgres, so that at most ONE API process runs the bot runner at a
// time. Without it, two processes with BOT_RUNNER_ENABLED=true would each attach every RUNNING
// bot and place every trade twice with real money.
//
// How it stays safe:
//  - Acquire/renew is ONE atomic statement using the DATABASE clock (now()), never an
//    application clock, so skew between hosts can't produce two holders.
//  - The holder renews every ttl/3. If it cannot CONFIRM a renewal it stops acting as leader
//    *before* the database lease can expire: local validity is measured on a monotonic clock
//    starting from before the renewal request was sent, minus a safety margin. A standby can
//    therefore never take over while the old holder still believes it is leader.
//  - `isHeld()` is checked by the runner immediately before every order is placed. A process
//    that was frozen (GC stall, VM pause) past its validity sees `false` on resume.
//
// Residual risk (documented in docs/operations.md): a process frozen between that last check and
// the network write of a buy could still send one order after losing the lease. The window is
// microseconds wide and there is no cross-system fencing token available from Deriv.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { logger } from "./logger.js";
import type { LeaseStore } from "./pgLeaseStore.js";

export { PgLeaseStore, type LeaseStore } from "./pgLeaseStore.js";

export interface RunnerLeaseOptions {
  store: LeaseStore;
  name: string;
  /** How long a lease lasts without renewal. Failover time after a crash is at most this. */
  ttlMs?: number;
  holderId?: string;
  onAcquired: () => void | Promise<void>;
  /** Called when leadership is lost for ANY reason (also on stop()). Must stop all trading. */
  onLost: (reason: string) => void;
  /** Injectable for tests. Must be monotonic. */
  nowMs?: () => number;
}

export class RunnerLease {
  readonly holderId: string;
  private readonly ttlMs: number;
  private readonly renewEveryMs: number;
  private readonly safetyMarginMs: number;
  private readonly nowMs: () => number;
  private timer: NodeJS.Timeout | null = null;
  private validUntil = 0; // monotonic ms; 0 = not leader
  private leader = false;
  private ticking = false;
  private stopped = false;

  constructor(private readonly opts: RunnerLeaseOptions) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    if (this.ttlMs < 3_000) throw new Error("runner lease ttl must be at least 3000ms");
    this.renewEveryMs = Math.floor(this.ttlMs / 3);
    this.safetyMarginMs = Math.floor(this.ttlMs / 6);
    this.holderId = opts.holderId ?? `${hostname()}:${process.pid}:${randomUUID()}`;
    this.nowMs = opts.nowMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  }

  /** True only while this process may act as leader: it holds the lease AND its last confirmed
   *  renewal is recent enough that nobody else could have taken over. */
  isHeld(): boolean {
    return this.leader && this.nowMs() < this.validUntil;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.renewEveryMs);
    this.timer.unref?.();
  }

  /** Graceful stop: stops trading, then frees the lease so a standby can take over at once. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const wasLeader = this.leader;
    this.lose("shutting down");
    if (wasLeader) {
      try {
        await this.opts.store.release(this.opts.name, this.holderId);
      } catch (err) {
        logger.warn({ err }, "could not release runner lease on shutdown; it will expire on its own");
      }
    }
  }

  /** One acquire/renew attempt. Public so tests can drive it. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    // Watchdog first: a renewal request that hangs must not keep us "leader" past our validity.
    if (this.leader && this.nowMs() >= this.validUntil) this.lose("renewal not confirmed in time");
    if (this.ticking) return;
    this.ticking = true;
    const requestedAt = this.nowMs(); // BEFORE the request: the DB lease can only start later than this
    try {
      const got = await this.opts.store.tryAcquire(this.opts.name, this.holderId, this.ttlMs);
      if (this.stopped) return;
      if (got) {
        this.validUntil = requestedAt + this.ttlMs - this.safetyMarginMs;
        if (!this.leader) {
          this.leader = true;
          logger.info({ holderId: this.holderId }, "acquired bot-runner lease — this process is now the leader");
          try {
            await this.opts.onAcquired();
          } catch (err) {
            logger.error({ err }, "failed to start bot runner after acquiring the lease; releasing it");
            this.lose("startup failed");
            await this.opts.store.release(this.opts.name, this.holderId).catch(() => undefined);
          }
        }
      } else if (this.leader) {
        this.lose("another process holds the lease");
      }
    } catch (err) {
      // Could not confirm. Not fatal by itself — but never trade past our last confirmed validity.
      logger.warn({ err }, "runner lease renewal failed");
      if (this.leader && this.nowMs() >= this.validUntil) this.lose("could not renew before the lease could expire");
    } finally {
      this.ticking = false;
    }
  }

  private lose(reason: string): void {
    if (!this.leader) return;
    this.leader = false;
    this.validUntil = 0;
    logger.warn({ reason }, "bot-runner leadership ended — trading stopped on this process");
    try {
      this.opts.onLost(reason);
    } catch (err) {
      logger.error({ err }, "onLost handler threw");
    }
  }
}
