import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, dbTestsEnabled, pgErrorCode, type TestDb } from "./harness.js";

const UNIQUE_VIOLATION = "23505";

describe.skipIf(!dbTestsEnabled)("data-integrity behaviour on a real PostgreSQL", () => {
  let db: TestDb;
  const q = (sql: string, params: unknown[] = []) => db.su.query(sql, params);
  const count = async (table: string, where = "true") => (await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n as number;

  async function seedUser(id: string, email: string) {
    await q(`INSERT INTO users (id, email, password_hash, handle) VALUES ($1, $2, 'h', $3)`, [id, email, `handle_${id}`]);
    await q(
      `INSERT INTO deriv_accounts (id, user_id, deriv_account_id, account_type, currency, "group", status) VALUES ($1, $2, $3, 'DEMO', 'USD', 'g', 'active')`,
      [`acc_${id}`, id, `VRTC_${id}`],
    );
    await q(`INSERT INTO sessions (id, user_id, expires_at, active_deriv_account_id) VALUES ($1, $2, now() + interval '1 hour', $3)`, [`sess_${id}`, id, `acc_${id}`]);
    await q(
      `INSERT INTO deriv_oauth_tokens (id, user_id, auth_type, access_token_enc, scopes, expires_at, deriv_client_id, updated_at) VALUES ($1, $2, 'OAUTH', 'enc', 'trade', now(), 'app', now())`,
      [`tok_${id}`, id],
    );
    await q(
      `INSERT INTO local_trades (id, user_id, deriv_account_id, contract_id, transaction_id, contract_type, underlying_symbol, buy_price, purchase_time) VALUES ($1, $2, $3, '555', '777', 'CALL', 'R_100', 10, now())`,
      [`lt_${id}`, id, `acc_${id}`],
    );
    await q(`INSERT INTO bot_strategies (id, key, name, description, definition, updated_at) VALUES ($1, $2, 'n', 'd', '{}', now()) ON CONFLICT DO NOTHING`, ["strat", "strat-key"]);
    await q(`INSERT INTO bot_instances (id, user_id, deriv_account_id, strategy_id, name, symbol, risk_params, updated_at) VALUES ($1, $2, $3, 'strat', 'b', 'R_100', '{}', now())`, [`bot_${id}`, id, `acc_${id}`]);
    await q(
      `INSERT INTO bot_trades (id, bot_instance_id, contract_id, transaction_id, contract_type, stake, stake_step, status, placed_at) VALUES ($1, $2, '555', '9', 'CALL', 1, 0, 'OPEN', now())`,
      [`bt_${id}`, `bot_${id}`],
    );
  }

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => db?.drop());

  it("a user's handle (their Deriv account id) is required and unique", async () => {
    await q(`INSERT INTO users (id, handle) VALUES ('h1', 'CR1000')`);
    expect(await pgErrorCode(db.su, `INSERT INTO users (id, handle) VALUES ('h2', 'CR1000')`)).toBe(UNIQUE_VIOLATION);
    expect(await pgErrorCode(db.su, `INSERT INTO users (id) VALUES ('h3')`)).toBe("23502"); // not_null_violation
  });

  it("email and password_hash are legacy: nullable, any number of users may have none, but a non-null email is still unique", async () => {
    await q(`INSERT INTO users (id, handle) VALUES ('n1', 'VRTC1'), ('n2', 'VRTC2')`); // two NULL emails: fine
    await q(`INSERT INTO users (id, handle, email) VALUES ('e1', 'VRTC3', 'dup@example.com')`);
    expect(await pgErrorCode(db.su, `INSERT INTO users (id, handle, email) VALUES ('e2', 'VRTC4', 'dup@example.com')`)).toBe(UNIQUE_VIOLATION);
  });

  it("a Deriv account id can belong to ONE user only — the DB refuses a second owner, so two people can never share an identity", async () => {
    await q(`INSERT INTO users (id, handle) VALUES ('o1', 'CR2000'), ('o2', 'CR2001')`);
    await q(`INSERT INTO deriv_accounts (id, user_id, deriv_account_id, account_type, currency, "group", status) VALUES ('oa1','o1','CR2000','REAL','USD','g','active')`);
    expect(await pgErrorCode(db.su, `INSERT INTO deriv_accounts (id, user_id, deriv_account_id, account_type, currency, "group", status) VALUES ('oa2','o2','CR2000','REAL','USD','g','active')`)).toBe(UNIQUE_VIOLATION);
  });

  it("one Deriv connection per user and one row per (user, Deriv account)", async () => {
    await seedUser("u1", "u1@example.com");
    expect(await pgErrorCode(db.su, `INSERT INTO deriv_oauth_tokens (id, user_id, auth_type, access_token_enc, scopes, expires_at, deriv_client_id, updated_at) VALUES ('tok2','u1','OAUTH','e','t',now(),'a',now())`)).toBe(UNIQUE_VIOLATION);
    expect(await pgErrorCode(db.su, `INSERT INTO deriv_accounts (id, user_id, deriv_account_id, account_type, currency, "group", status) VALUES ('acc2','u1','VRTC_u1','DEMO','USD','g','active')`)).toBe(UNIQUE_VIOLATION);
  });

  it("the buy flow's upsert key works: the same contract on the same account cannot be recorded twice, but another account can hold the same contract id", async () => {
    // trading.controller upserts on (deriv_account_id, contract_id)
    expect(await pgErrorCode(db.su, `INSERT INTO local_trades (id, user_id, deriv_account_id, contract_id, transaction_id, contract_type, underlying_symbol, buy_price, purchase_time) VALUES ('lt2','u1','acc_u1','555','778','CALL','R_100',1,now())`)).toBe(UNIQUE_VIOLATION);
    await seedUser("u2", "u2@example.com"); // also has contract '555', on ITS account
    expect(await count("local_trades", "contract_id = '555'")).toBe(2);
    // and the ON CONFLICT form Prisma emits for upsert is accepted by the index:
    await q(
      `INSERT INTO local_trades (id, user_id, deriv_account_id, contract_id, transaction_id, contract_type, underlying_symbol, buy_price, purchase_time)
       VALUES ('lt3','u1','acc_u1','555','779','CALL','R_100',1,now())
       ON CONFLICT (deriv_account_id, contract_id) DO UPDATE SET status = 'OPEN'`,
    );
    expect(await count("local_trades", "user_id = 'u1'")).toBe(1);
  });

  it("a withdrawal request_id (our idempotency key) can only be used once", async () => {
    await q(`INSERT INTO payment_agent_withdrawals (id, user_id, deriv_account_id, agent_id, amount, currency, request_id, updated_at) VALUES ('w1','u1','acc_u1','1',5,'USD','same-req',now())`);
    expect(await pgErrorCode(db.su, `INSERT INTO payment_agent_withdrawals (id, user_id, deriv_account_id, agent_id, amount, currency, request_id, updated_at) VALUES ('w2','u2','acc_u2','1',5,'USD','same-req',now())`)).toBe(UNIQUE_VIOLATION);
  });

  it("deleting an account the session is using sets the session's active account to NULL (a session can never keep trading on a removed account)", async () => {
    await q(`DELETE FROM deriv_accounts WHERE id = 'acc_u2'`);
    expect((await q(`SELECT active_deriv_account_id FROM sessions WHERE id = 'sess_u2'`)).rows[0].active_deriv_account_id).toBeNull();
    expect(await count("sessions", "id = 'sess_u2'")).toBe(1); // the session itself survives
  });

  it("deleting a user removes everything they own — sessions, tokens, accounts, trades, bots — and nobody else's", async () => {
    expect(await count("bot_trades", "bot_instance_id = 'bot_u1'")).toBe(1); // the seed rows exist, so 0 below means "cascaded"
    await q(`DELETE FROM users WHERE id = 'u1'`);
    for (const [table, col] of [["sessions", "user_id"], ["deriv_oauth_tokens", "user_id"], ["deriv_accounts", "user_id"], ["local_trades", "user_id"], ["bot_instances", "user_id"], ["payment_agent_withdrawals", "user_id"]] as const) {
      expect(await count(table, `${col} = 'u1'`), table).toBe(0);
    }
    expect(await count("bot_trades", "bot_instance_id = 'bot_u1'")).toBe(0);
    expect(await count("users", "id = 'u2'")).toBe(1);
    expect(await count("deriv_oauth_tokens", "user_id = 'u2'")).toBe(1);
  });

  it("the audit trail outlives the user it describes (no foreign key from audit_logs)", async () => {
    await q(`INSERT INTO audit_logs (id, actor_type, actor_id, actor_email, action, target_type) VALUES ('al', 'CLIENT', 'u2', 'u2@example.com', 'x', 'y')`);
    await q(`DELETE FROM users WHERE id = 'u2'`);
    expect(await count("audit_logs", "id = 'al'")).toBe(1);
  });

  it("a strategy that bots use cannot be deleted out from under them", async () => {
    await seedUser("u3", "u3@example.com");
    expect(["23001", "23503"]).toContain(await pgErrorCode(db.su, `DELETE FROM bot_strategies WHERE id = 'strat'`));
  });

  describe("admin TOTP replay protection (compare-and-set on the stored ciphertext)", () => {
    // admin-api's authenticateAdmin issues, via Prisma updateMany:
    //   UPDATE admin_users SET totp_secret_enc = <new> WHERE id = <id> AND totp_secret_enc = <old>
    // Its unit tests prove the logic against an in-memory fake; this proves Postgres itself gives
    // the exactly-one-winner guarantee under real concurrent connections.
    it("lets exactly ONE of N simultaneous consumers of the same code win", async () => {
      await q(`INSERT INTO admin_users (id, email, password_hash, totp_secret_enc) VALUES ('adm', 'a@example.com', 'x', 'v1.OLD')`);
      const clients = await Promise.all(Array.from({ length: 8 }, async () => db.as("derivdesk_admin")));
      const results = await Promise.all(
        clients.map((c, i) => c.query(`UPDATE admin_users SET totp_secret_enc = $1 WHERE id = 'adm' AND totp_secret_enc = 'v1.OLD'`, [`v1.NEW${i}`])),
      );
      const winners = results.filter((r) => r.rowCount === 1);
      expect(winners).toHaveLength(1);
      expect((await q(`SELECT totp_secret_enc FROM admin_users WHERE id = 'adm'`)).rows[0].totp_secret_enc).toMatch(/^v1\.NEW\d$/);
    });
  });

  it("sessions can be bulk-pruned by the exact queries the login housekeeping runs", async () => {
    await q(`INSERT INTO users (id, handle) VALUES ('many', 'many-handle')`);
    for (let i = 0; i < 13; i++) {
      await q(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ($1, 'many', now() - ($2 || ' minutes')::interval, now() + interval '1 hour')`, [`ms${i}`, String(i)]);
    }
    await q(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('expired', 'many', now() - interval '1 hour')`);
    // pruneSessions(): drop expired, then everything beyond the newest 10 (skip 10, newest first)
    await q(`DELETE FROM sessions WHERE user_id = 'many' AND expires_at < now()`);
    const surplus = await q(`SELECT id FROM sessions WHERE user_id = 'many' ORDER BY created_at DESC OFFSET 10`);
    await q(`DELETE FROM sessions WHERE id = ANY($1)`, [surplus.rows.map((r) => r.id)]);
    expect(await count("sessions", "user_id = 'many'")).toBe(10);
    expect(await count("sessions", "id = 'ms0'")).toBe(1); // the newest survives
    expect(await count("sessions", "id = 'ms12'")).toBe(0); // the oldest was revoked
  });
});
