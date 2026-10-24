-- DerivDesk initial schema.
--
-- NOTE: hand-authored to match packages/db/prisma/schema.prisma, because this
-- sandbox's network egress cannot reach binaries.prisma.sh (Prisma's engine
-- binary host) and so `prisma migrate dev` could not be run here. Before
-- relying on this in a real environment: delete this migrations folder and
-- run `npm run db:migrate -- --name init` once with normal network access —
-- Prisma will generate its own copy of this file from schema.prisma and you
-- can diff it against this one. Do not hand-edit migrations after that.

-- Enums
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "AdminUserStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "DerivAuthType" AS ENUM ('OAUTH', 'PAT');
CREATE TYPE "DerivAccountType" AS ENUM ('DEMO', 'REAL');
CREATE TYPE "TradeStatus" AS ENUM ('OPEN', 'CLOSED', 'SOLD', 'CANCELLED');
CREATE TYPE "TransactionSource" AS ENUM ('STATEMENT', 'TRANSACTION', 'PROFIT_TABLE');
CREATE TYPE "WithdrawalStatus" AS ENUM ('REQUESTED', 'PENDING', 'COMPLETE', 'REJECTED', 'FAILED');
CREATE TYPE "ActorType" AS ENUM ('CLIENT', 'ADMIN', 'SYSTEM');

-- users
CREATE TABLE "users" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_login_at" TIMESTAMP(3),
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- sessions
CREATE TABLE "sessions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "ip" TEXT,
  "user_agent" TEXT,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- admin_users (deliberately unrelated to users)
CREATE TABLE "admin_users" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "totp_secret_enc" TEXT,
  "status" "AdminUserStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_login_at" TIMESTAMP(3),
  CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- admin_sessions
CREATE TABLE "admin_sessions" (
  "id" TEXT NOT NULL,
  "admin_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "ip" TEXT,
  "user_agent" TEXT,
  CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "admin_sessions_admin_user_id_idx" ON "admin_sessions"("admin_user_id");
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_fkey"
  FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- deriv_oauth_tokens
CREATE TABLE "deriv_oauth_tokens" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "auth_type" "DerivAuthType" NOT NULL,
  "access_token_enc" TEXT NOT NULL,
  "refresh_token_enc" TEXT,
  "scopes" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "deriv_client_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "deriv_oauth_tokens_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "deriv_oauth_tokens_user_id_idx" ON "deriv_oauth_tokens"("user_id");
ALTER TABLE "deriv_oauth_tokens" ADD CONSTRAINT "deriv_oauth_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- deriv_accounts
CREATE TABLE "deriv_accounts" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "deriv_account_id" TEXT NOT NULL,
  "account_type" "DerivAccountType" NOT NULL,
  "currency" TEXT NOT NULL,
  "group" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "nickname" TEXT,
  "cached_balance" DECIMAL(18,4),
  "cached_balance_at" TIMESTAMP(3),
  CONSTRAINT "deriv_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "deriv_accounts_user_id_deriv_account_id_key" ON "deriv_accounts"("user_id", "deriv_account_id");
CREATE INDEX "deriv_accounts_user_id_account_type_idx" ON "deriv_accounts"("user_id", "account_type");
ALTER TABLE "deriv_accounts" ADD CONSTRAINT "deriv_accounts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- watchlists
CREATE TABLE "watchlists" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT 'Default',
  CONSTRAINT "watchlists_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- watchlist_items
CREATE TABLE "watchlist_items" (
  "id" TEXT NOT NULL,
  "watchlist_id" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "watchlist_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "watchlist_items_watchlist_id_idx" ON "watchlist_items"("watchlist_id");
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_watchlist_id_fkey"
  FOREIGN KEY ("watchlist_id") REFERENCES "watchlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- local_trades
CREATE TABLE "local_trades" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "deriv_account_id" TEXT NOT NULL,
  "contract_id" TEXT NOT NULL,
  "transaction_id" TEXT NOT NULL,
  "contract_type" TEXT NOT NULL,
  "underlying_symbol" TEXT NOT NULL,
  "buy_price" DECIMAL(18,4) NOT NULL,
  "payout" DECIMAL(18,4),
  "purchase_time" TIMESTAMP(3) NOT NULL,
  "status" "TradeStatus" NOT NULL DEFAULT 'OPEN',
  "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "local_trades_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "local_trades_deriv_account_id_contract_id_key" ON "local_trades"("deriv_account_id", "contract_id");
CREATE INDEX "local_trades_user_id_status_idx" ON "local_trades"("user_id", "status");
ALTER TABLE "local_trades" ADD CONSTRAINT "local_trades_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "local_trades" ADD CONSTRAINT "local_trades_deriv_account_id_fkey"
  FOREIGN KEY ("deriv_account_id") REFERENCES "deriv_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- transactions_cache
CREATE TABLE "transactions_cache" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "deriv_account_id" TEXT NOT NULL,
  "deriv_transaction_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL,
  "currency" TEXT NOT NULL,
  "balance_after" DECIMAL(18,4),
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "source" "TransactionSource" NOT NULL,
  CONSTRAINT "transactions_cache_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "transactions_cache_deriv_account_id_deriv_transaction_id_key" ON "transactions_cache"("deriv_account_id", "deriv_transaction_id");
CREATE INDEX "transactions_cache_user_id_occurred_at_idx" ON "transactions_cache"("user_id", "occurred_at" DESC);
ALTER TABLE "transactions_cache" ADD CONSTRAINT "transactions_cache_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transactions_cache" ADD CONSTRAINT "transactions_cache_deriv_account_id_fkey"
  FOREIGN KEY ("deriv_account_id") REFERENCES "deriv_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- payment_agent_withdrawals
CREATE TABLE "payment_agent_withdrawals" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "deriv_account_id" TEXT NOT NULL,
  "agent_id" TEXT NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL,
  "currency" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_agent_withdrawals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_agent_withdrawals_request_id_key" ON "payment_agent_withdrawals"("request_id");
CREATE INDEX "payment_agent_withdrawals_user_id_status_idx" ON "payment_agent_withdrawals"("user_id", "status");
ALTER TABLE "payment_agent_withdrawals" ADD CONSTRAINT "payment_agent_withdrawals_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_agent_withdrawals" ADD CONSTRAINT "payment_agent_withdrawals_deriv_account_id_fkey"
  FOREIGN KEY ("deriv_account_id") REFERENCES "deriv_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- analytics_snapshots
CREATE TABLE "analytics_snapshots" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "deriv_account_id" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "win_rate" DECIMAL(5,4),
  "net_pnl" DECIMAL(18,4) NOT NULL,
  "trades_count" INTEGER NOT NULL,
  "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "analytics_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "analytics_snapshots_deriv_account_id_period_key" ON "analytics_snapshots"("deriv_account_id", "period");
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_deriv_account_id_fkey"
  FOREIGN KEY ("deriv_account_id") REFERENCES "deriv_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- notifications
CREATE TABLE "notifications" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- audit_logs (no FK — actor may be a client User or an AdminUser from a
-- different deployment/database role)
CREATE TABLE "audit_logs" (
  "id" TEXT NOT NULL,
  "actor_type" "ActorType" NOT NULL,
  "actor_id" TEXT NOT NULL,
  "actor_email" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT,
  "metadata" JSONB,
  "ip" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at" DESC);
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- feature_flags
CREATE TABLE "feature_flags" (
  "key" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "updated_by" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);
