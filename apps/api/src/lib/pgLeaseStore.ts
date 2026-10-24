// Postgres storage for the bot-runner lease (see runnerLease.ts for the protocol and why it is
// safe). Deliberately free of logger/config imports so the database test suite can run THIS code
// against a real Postgres.

import type { PrismaClient } from "@derivdesk/db";

export interface LeaseStore {
  /** Atomically acquire or renew. Resolves true iff `holderId` holds the lease afterwards. */
  tryAcquire(name: string, holderId: string, ttlMs: number): Promise<boolean>;
  /** Give the lease up immediately, only if `holderId` still holds it. */
  release(name: string, holderId: string): Promise<void>;
}

export class PgLeaseStore implements LeaseStore {
  constructor(private readonly db: Pick<PrismaClient, "$queryRaw" | "$executeRaw">) {}

  async tryAcquire(name: string, holderId: string, ttlMs: number): Promise<boolean> {
    // The WHERE on DO UPDATE is the whole trick: an existing row is only taken over if it is
    // ours already (renewal) or has expired. Otherwise no row is returned and we do not hold it.
    const rows = (await this.db.$queryRaw`
      INSERT INTO runner_leases (name, holder_id, acquired_at, renewed_at, expires_at)
      VALUES (${name}, ${holderId}, now(), now(), now() + make_interval(secs => ${ttlMs / 1000}::double precision))
      ON CONFLICT (name) DO UPDATE SET
        acquired_at = CASE WHEN runner_leases.holder_id = EXCLUDED.holder_id THEN runner_leases.acquired_at ELSE now() END,
        holder_id   = EXCLUDED.holder_id,
        renewed_at  = now(),
        expires_at  = EXCLUDED.expires_at
      WHERE runner_leases.holder_id = EXCLUDED.holder_id OR runner_leases.expires_at < now()
      RETURNING holder_id
    `) as Array<{ holder_id: string }>;
    return rows.length === 1 && rows[0]!.holder_id === holderId;
  }

  async release(name: string, holderId: string): Promise<void> {
    await this.db.$executeRaw`DELETE FROM runner_leases WHERE name = ${name} AND holder_id = ${holderId}`;
  }
}
