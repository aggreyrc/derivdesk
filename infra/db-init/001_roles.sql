-- DerivDesk — database-level privilege separation between the two
-- deployments. This is what makes "fully separate admin deployment"
-- actually mean something: even if apps/admin-api has a query bug or is
-- compromised, its DB role physically cannot read deriv_oauth_tokens or the
-- users.password_hash column. Run this once against a fresh database,
-- after migrations have been applied.
--
-- Usage: psql "$DATABASE_URL" -f infra/db-init/001_roles.sql
-- (or mount this file into postgres's /docker-entrypoint-initdb.d — see
-- docker-compose.yml — for a brand-new local DB)

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'derivdesk_api') THEN
    CREATE ROLE derivdesk_api LOGIN PASSWORD 'change_me_api';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'derivdesk_admin') THEN
    CREATE ROLE derivdesk_admin LOGIN PASSWORD 'change_me_admin';
  END IF;
END
$$;

-- Neither role gets broad schema privileges by default.
REVOKE ALL ON SCHEMA public FROM derivdesk_api, derivdesk_admin;
GRANT USAGE ON SCHEMA public TO derivdesk_api, derivdesk_admin;

-- ---------------------------------------------------------------------------
-- derivdesk_api (apps/api) — everything a client-facing backend needs,
-- INCLUDING deriv_oauth_tokens (it's the only service that ever decrypts a
-- Deriv token). It has no access to admin_users / admin_sessions at all.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions,
  deriv_oauth_tokens, deriv_accounts,
  watchlists, watchlist_items,
  local_trades, transactions_cache,
  payment_agent_withdrawals, analytics_snapshots,
  notifications,
  bot_instances, bot_trades,
  runner_leases                -- the bot-runner leader lease (apps/api/src/lib/runnerLease.ts)
TO derivdesk_api;

GRANT SELECT ON feature_flags TO derivdesk_api;       -- reads flags, never writes them
GRANT SELECT ON bot_strategies TO derivdesk_api;      -- reads the admin-managed catalog, never writes it
GRANT SELECT, INSERT ON audit_logs TO derivdesk_api;  -- writes its own actions, never edits history

-- ---------------------------------------------------------------------------
-- derivdesk_admin (apps/admin-api) — operational visibility only.
-- No grant at all on: deriv_oauth_tokens (tokens must never be reachable
-- from the admin deployment), admin's own table is separate from users, and
-- it can only ever mutate the app-level `status` surface via the view below.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON admin_users TO derivdesk_admin;
-- DELETE is needed on sessions only: sign-out, revoking old sessions at login, and re-enrolling 2FA all delete rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_sessions TO derivdesk_admin;

-- Admin never sees password_hash — expose a column-limited view instead of
-- the raw users table.
-- DROP + CREATE (not CREATE OR REPLACE): Postgres cannot drop a column from a view, and the legacy
-- `email` must stop being visible to admins. The grant below is re-applied straight after, and this
-- script runs before the apps start (scripts/migrate-entrypoint.sh).
DROP VIEW IF EXISTS admin_visible_users;
CREATE VIEW admin_visible_users AS
  SELECT id, handle, status, created_at, last_login_at FROM users;
GRANT SELECT ON admin_visible_users TO derivdesk_admin;

-- Suspending/reactivating an app account is the one client-table mutation an
-- admin can make; a rule (not a broad UPDATE grant) is what allows it.
CREATE OR REPLACE FUNCTION admin_set_user_status(p_user_id TEXT, p_status "UserStatus")
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE users SET status = p_status WHERE id = p_user_id;
$$;
REVOKE ALL ON FUNCTION admin_set_user_status(TEXT, "UserStatus") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_set_user_status(TEXT, "UserStatus") TO derivdesk_admin;

GRANT SELECT ON deriv_accounts TO derivdesk_admin;              -- connection health view; no balances beyond the cached column, no tokens
GRANT SELECT ON payment_agent_withdrawals TO derivdesk_admin;   -- support triage, read-only
GRANT SELECT, INSERT, UPDATE ON feature_flags TO derivdesk_admin;       -- the one thing admin fully owns
GRANT SELECT, INSERT, UPDATE, DELETE ON bot_strategies TO derivdesk_admin; -- the strategy CATALOG only — templates, never a user's running instance. DELETE only undoes a mistaken draft: bot_instances.strategy_id is ON DELETE RESTRICT, so an in-use strategy can't be removed
GRANT SELECT, INSERT ON audit_logs TO derivdesk_admin;          -- writes its own actions, never edits history

-- Explicit belt-and-braces: make the absence of a grant on the sensitive
-- tables impossible to miss in a future migration.
REVOKE ALL ON deriv_oauth_tokens FROM derivdesk_admin;
REVOKE ALL ON users FROM derivdesk_admin;
REVOKE ALL ON sessions FROM derivdesk_admin;
REVOKE ALL ON local_trades FROM derivdesk_admin;
REVOKE ALL ON transactions_cache FROM derivdesk_admin;
REVOKE ALL ON watchlists, watchlist_items FROM derivdesk_admin;
REVOKE ALL ON notifications FROM derivdesk_admin;
REVOKE ALL ON bot_instances, bot_trades, runner_leases FROM derivdesk_admin;  -- admin sees the catalog, never a user's running bot, config, or trades
REVOKE ALL ON admin_users, admin_sessions FROM derivdesk_api;
