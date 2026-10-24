-- Bot trading: admin-managed strategy catalog (bot_strategies) + per-user bot instances and
-- their trade log (bot_instances, bot_trades).
--
-- NOTE: hand-authored, same reason and same caveat as the initial migration
-- (packages/db/prisma/migrations/20260926000000_init/migration.sql) — this sandbox cannot
-- reach binaries.prisma.sh, so `prisma migrate dev` could not generate this file here. Before
-- relying on this in a real environment, regenerate it with `npm run db:migrate -- --name
-- bot_trading` from an environment with normal network access and diff the result against
-- this file; do not hand-edit migrations after that.

-- Enums
CREATE TYPE "BotStrategyStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "BotInstanceStatus" AS ENUM ('DRAFT', 'RUNNING', 'PAUSED', 'STOPPED', 'ERROR');

-- bot_strategies
CREATE TABLE "bot_strategies" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "definition" JSONB NOT NULL,
  "status" "BotStrategyStatus" NOT NULL DEFAULT 'DRAFT',
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bot_strategies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bot_strategies_key_key" ON "bot_strategies"("key");

-- bot_instances
CREATE TABLE "bot_instances" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "deriv_account_id" TEXT NOT NULL,
  "strategy_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "risk_params" JSONB NOT NULL,
  "confirm_real" BOOLEAN NOT NULL DEFAULT false,
  "status" "BotInstanceStatus" NOT NULL DEFAULT 'DRAFT',
  "stop_reason" TEXT,
  "staking_state" JSONB NOT NULL DEFAULT '{"currentStep":0}',
  "risk_state" JSONB NOT NULL DEFAULT '{"sessionProfitLoss":0,"consecutiveLosses":0,"tradesCount":0}',
  "last_evaluated_at" TIMESTAMP(3),
  "last_error" TEXT,
  "started_at" TIMESTAMP(3),
  "stopped_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bot_instances_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bot_instances_user_id_idx" ON "bot_instances"("user_id");
CREATE INDEX "bot_instances_status_idx" ON "bot_instances"("status");
ALTER TABLE "bot_instances" ADD CONSTRAINT "bot_instances_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_instances" ADD CONSTRAINT "bot_instances_deriv_account_id_fkey"
  FOREIGN KEY ("deriv_account_id") REFERENCES "deriv_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_instances" ADD CONSTRAINT "bot_instances_strategy_id_fkey"
  FOREIGN KEY ("strategy_id") REFERENCES "bot_strategies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- bot_trades
CREATE TABLE "bot_trades" (
  "id" TEXT NOT NULL,
  "bot_instance_id" TEXT NOT NULL,
  "contract_id" TEXT NOT NULL,
  "transaction_id" TEXT NOT NULL,
  "contract_type" TEXT NOT NULL,
  "stake" DECIMAL(18,4) NOT NULL,
  "stake_step" INTEGER NOT NULL,
  "payout" DECIMAL(18,4),
  "profit" DECIMAL(18,4),
  "status" "TradeStatus" NOT NULL DEFAULT 'OPEN',
  "placed_at" TIMESTAMP(3) NOT NULL,
  "settled_at" TIMESTAMP(3),
  CONSTRAINT "bot_trades_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bot_trades_bot_instance_id_placed_at_idx" ON "bot_trades"("bot_instance_id", "placed_at" DESC);
ALTER TABLE "bot_trades" ADD CONSTRAINT "bot_trades_bot_instance_id_fkey"
  FOREIGN KEY ("bot_instance_id") REFERENCES "bot_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Privilege grants for the new tables (mirrors infra/db-init/001_roles.sql —
-- run that file's equivalent lines too if applying grants separately from a
-- fresh bootstrap; included here so this migration is self-contained for
-- anyone applying it directly against an already-running database).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'derivdesk_api') THEN
    GRANT SELECT ON "bot_strategies" TO derivdesk_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "bot_instances", "bot_trades" TO derivdesk_api;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'derivdesk_admin') THEN
    GRANT SELECT, INSERT, UPDATE ON "bot_strategies" TO derivdesk_admin;
    REVOKE ALL ON "bot_instances", "bot_trades" FROM derivdesk_admin;
  END IF;
END
$$;
