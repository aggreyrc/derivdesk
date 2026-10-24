import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSION_DENIED, createTestDb, dbTestsEnabled, pgErrorCode, type TestDb } from "./harness.js";

// The admin deployment's isolation from client data is claimed to be enforced "by Postgres, not by
// app code" (infra/db-init/001_roles.sql). These tests log in as the real roles and try to break it.

describe.skipIf(!dbTestsEnabled)("least-privilege database roles", () => {
  let db: TestDb;
  let admin: pg.Client;
  let api: pg.Client;

  beforeAll(async () => {
    db = await createTestDb();
    admin = await db.as("derivdesk_admin");
    api = await db.as("derivdesk_api");

    // Seed as superuser: a client user with a Deriv connection, session, bot, trade, withdrawal…
    await db.su.query(`
      INSERT INTO users (id, handle, email, password_hash) VALUES ('u1', 'CR123', 'legacy@example.com', 'legacy-hash-should-never-reach-admin');
      INSERT INTO deriv_accounts (id, user_id, deriv_account_id, account_type, currency, "group", status)
        VALUES ('a1', 'u1', 'CR123', 'REAL', 'USD', 'g', 'active');
      INSERT INTO deriv_oauth_tokens (id, user_id, auth_type, access_token_enc, scopes, expires_at, deriv_client_id, updated_at)
        VALUES ('t1', 'u1', 'OAUTH', 'v1.enc.enc.enc', 'trade', now(), 'app', now());
      INSERT INTO sessions (id, user_id, expires_at) VALUES ('s1', 'u1', now() + interval '1 hour');
      INSERT INTO bot_strategies (id, key, name, description, definition, updated_at) VALUES ('st1', 'k', 'n', 'd', '{}', now());
      INSERT INTO bot_instances (id, user_id, deriv_account_id, strategy_id, name, symbol, risk_params, updated_at)
        VALUES ('b1', 'u1', 'a1', 'st1', 'my bot', 'R_100', '{}', now());
      INSERT INTO payment_agent_withdrawals (id, user_id, deriv_account_id, agent_id, amount, currency, request_id, updated_at)
        VALUES ('w1', 'u1', 'a1', '9', 10, 'USD', 'req-1', now());
      INSERT INTO admin_users (id, email, password_hash) VALUES ('ad1', 'ops@example.com', 'x');
      INSERT INTO admin_sessions (id, admin_user_id, expires_at) VALUES ('as1', 'ad1', now() + interval '1 hour');
      INSERT INTO audit_logs (id, actor_type, actor_id, actor_email, action, target_type) VALUES ('l1', 'CLIENT', 'u1', 'CR123', 'x', 'y');
    `);
  });
  afterAll(async () => db?.drop());

  describe("derivdesk_admin (the ops console's role)", () => {
    it.each([
      "deriv_oauth_tokens",
      "users",
      "sessions",
      "local_trades",
      "transactions_cache",
      "watchlists",
      "watchlist_items",
      "notifications",
      "bot_instances",
      "bot_trades",
      "analytics_snapshots",
    ])("cannot even SELECT from %s", async (table) => {
      expect(await pgErrorCode(admin, `SELECT * FROM ${table} LIMIT 1`)).toBe(PERMISSION_DENIED);
    });

    it("cannot read a client's password hash — only the column-limited view exists", async () => {
      expect(await pgErrorCode(admin, `SELECT password_hash FROM users`)).toBe(PERMISSION_DENIED);
      const { rows } = await admin.query(`SELECT * FROM admin_visible_users`);
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual(["created_at", "handle", "id", "last_login_at", "status"]);
      expect(JSON.stringify(rows)).not.toContain("legacy-hash");
      expect(JSON.stringify(rows)).not.toContain("legacy@example.com"); // legacy email is not exposed either
    });

    it("cannot read client Deriv tokens via any column or by joining", async () => {
      expect(await pgErrorCode(admin, `SELECT access_token_enc FROM deriv_oauth_tokens`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(admin, `SELECT a.id FROM deriv_accounts a JOIN deriv_oauth_tokens t ON t.user_id = a.user_id`)).toBe(PERMISSION_DENIED);
    });

    it("can read connection health, withdrawals (triage) and the strategy catalog, but NOT write them", async () => {
      expect((await admin.query(`SELECT count(*)::int AS n FROM deriv_accounts`)).rows[0].n).toBe(1);
      expect((await admin.query(`SELECT count(*)::int AS n FROM payment_agent_withdrawals`)).rows[0].n).toBe(1);
      expect(await pgErrorCode(admin, `UPDATE deriv_accounts SET cached_balance = 1000000`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(admin, `UPDATE payment_agent_withdrawals SET status = 'COMPLETE'`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(admin, `DELETE FROM payment_agent_withdrawals`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(admin, `INSERT INTO payment_agent_withdrawals (id, user_id, deriv_account_id, agent_id, amount, currency, request_id, updated_at) VALUES ('x','u1','a1','1',1,'USD','r2',now())`)).toBe(PERMISSION_DENIED);
    });

    it("can suspend a user only through the narrow admin_set_user_status() function, not by writing users", async () => {
      expect(await pgErrorCode(admin, `UPDATE users SET status = 'SUSPENDED'`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(admin, `DELETE FROM users`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(admin, `SELECT admin_set_user_status('u1', 'SUSPENDED')`)).toBeNull();
      expect((await db.su.query(`SELECT status FROM users WHERE id = 'u1'`)).rows[0].status).toBe("SUSPENDED");
      await db.su.query(`UPDATE users SET status = 'ACTIVE' WHERE id = 'u1'`);
    });

    it("the function cannot be abused to change anything but status (it takes only an id and a status)", async () => {
      // Injection-shaped id is just a value; it matches nothing.
      await admin.query(`SELECT admin_set_user_status($1, 'SUSPENDED')`, [`u1' OR '1'='1`]);
      expect((await db.su.query(`SELECT status FROM users WHERE id = 'u1'`)).rows[0].status).toBe("ACTIVE");
    });

    it("can write the strategy CATALOG (including deleting a draft) but a strategy in use by a bot cannot be deleted", async () => {
      expect(await pgErrorCode(admin, `INSERT INTO bot_strategies (id, key, name, description, definition, updated_at) VALUES ('st2','k2','n','d','{}', now())`)).toBeNull();
      expect(await pgErrorCode(admin, `DELETE FROM bot_strategies WHERE id = 'st2'`)).toBeNull(); // needs the DELETE grant added in Phase 6
      const inUse = await pgErrorCode(admin, `DELETE FROM bot_strategies WHERE id = 'st1'`);
      expect(["23001", "23503"]).toContain(inUse); // restrict_violation / foreign_key_violation
    });

    it("can toggle feature flags", async () => {
      expect(await pgErrorCode(admin, `INSERT INTO feature_flags (key, enabled, updated_at) VALUES ('f', true, now())`)).toBeNull();
      expect(await pgErrorCode(admin, `UPDATE feature_flags SET enabled = false WHERE key = 'f'`)).toBeNull();
    });

    it("can sign out (DELETE on admin_sessions) — without this grant admin logout would fail in production", async () => {
      expect(await pgErrorCode(admin, `DELETE FROM admin_sessions WHERE id = 'as1'`)).toBeNull();
    });

    it("can update an admin's TOTP state (needed for replay protection) but cannot delete admin users", async () => {
      expect(await pgErrorCode(admin, `UPDATE admin_users SET totp_secret_enc = 'v1.a.b.c' WHERE id = 'ad1'`)).toBeNull();
      expect(await pgErrorCode(admin, `DELETE FROM admin_users WHERE id = 'ad1'`)).toBe(PERMISSION_DENIED);
    });

    it("can append to the audit log and read it, but can never edit or delete history", async () => {
      expect(await pgErrorCode(admin, `INSERT INTO audit_logs (id, actor_type, actor_id, actor_email, action, target_type) VALUES ('l2','ADMIN','ad1','ops@example.com','a','b')`)).toBeNull();
      expect((await admin.query(`SELECT count(*)::int AS n FROM audit_logs`)).rows[0].n).toBeGreaterThanOrEqual(2);
      expect(await pgErrorCode(admin, `UPDATE audit_logs SET action = 'tampered'`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(admin, `DELETE FROM audit_logs`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(admin, `TRUNCATE audit_logs`)).toBe(PERMISSION_DENIED);
    });

    it("cannot create objects, alter the schema, or see other schemas' tables", async () => {
      expect(await pgErrorCode(admin, `CREATE TABLE evil (id int)`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(admin, `ALTER TABLE users ADD COLUMN x int`)).not.toBeNull();
      expect(await pgErrorCode(admin, `DROP TABLE audit_logs`)).not.toBeNull();
    });
  });

  describe("derivdesk_api (the client backend's role)", () => {
    it("cannot read or write any admin identity table", async () => {
      expect(await pgErrorCode(api, `SELECT * FROM admin_users`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(api, `SELECT * FROM admin_sessions`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(api, `UPDATE admin_users SET status = 'ACTIVE'`)).toBe(PERMISSION_DENIED);
    });

    it("can append to the audit log but cannot edit or delete it", async () => {
      expect(await pgErrorCode(api, `INSERT INTO audit_logs (id, actor_type, actor_id, actor_email, action, target_type) VALUES ('l3','CLIENT','u1','CR123','trading.buy','local_trade')`)).toBeNull();
      expect(await pgErrorCode(api, `UPDATE audit_logs SET action = 'tampered'`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(api, `DELETE FROM audit_logs`)).toBe(PERMISSION_DENIED);
    });

    it("can READ the strategy catalog and feature flags but not write them (the admin owns those)", async () => {
      expect((await api.query(`SELECT count(*)::int AS n FROM bot_strategies`)).rows[0].n).toBeGreaterThanOrEqual(1);
      expect(await pgErrorCode(api, `UPDATE bot_strategies SET status = 'PUBLISHED'`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(api, `DELETE FROM bot_strategies`)).toBe(PERMISSION_DENIED);
      expect(await pgErrorCode(api, `UPDATE feature_flags SET enabled = true`)).toBe(PERMISSION_DENIED);
    });

    it("can do its own job: tokens, sessions, accounts, bots, withdrawals", async () => {
      for (const t of ["users", "sessions", "deriv_oauth_tokens", "deriv_accounts", "bot_instances", "bot_trades", "payment_agent_withdrawals", "local_trades"]) {
        expect(await pgErrorCode(api, `SELECT 1 FROM ${t} LIMIT 1`), t).toBeNull();
      }
      expect(await pgErrorCode(api, `UPDATE sessions SET active_deriv_account_id = 'a1' WHERE id = 's1'`)).toBeNull();
    });

    it("cannot alter the schema", async () => {
      expect(await pgErrorCode(api, `CREATE TABLE evil (id int)`)).toBe(PERMISSION_DENIED);
    });
  });
});
