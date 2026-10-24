-- Runner lease: guarantees at most one API process runs the bot runner at a time
-- (see apps/api/src/lib/runnerLease.ts). One row per named lease; expires_at is always
-- computed with the database's now(), never an application clock.
--
-- NOTE: hand-authored like the earlier migrations (this sandbox cannot reach
-- binaries.prisma.sh). Regenerate/diff with `prisma migrate dev` from a normal environment.

CREATE TABLE "runner_leases" (
  "name" TEXT NOT NULL,
  "holder_id" TEXT NOT NULL,
  "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "renewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "runner_leases_pkey" PRIMARY KEY ("name")
);
