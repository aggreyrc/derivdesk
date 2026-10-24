import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SUPERUSER_URL, dbTestsEnabled, migrationFiles } from "./harness.js";

// The Deriv-only sign-up migration runs against data that already exists in a deployment, so it is
// tested the way it will run: apply every EARLIER migration, insert legacy (email-era) rows, then
// apply this one. createTestDb() cannot do that — it applies everything up front.

const TARGET = "20261022000000_deriv_identity";
const files = migrationFiles();
const targetFile = files.find((f) => f.includes(TARGET))!;
const earlier = files.filter((f) => f < targetFile);

async function freshDb(): Promise<{ su: pg.Client; drop: () => Promise<void> }> {
  const name = `dd_mig_${randomBytes(5).toString("hex")}`;
  const admin = new pg.Client({ connectionString: SUPERUSER_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(SUPERUSER_URL!);
  u.pathname = `/${name}`;
  const su = new pg.Client({ connectionString: u.toString() });
  await su.connect();
  for (const f of earlier) await su.query(readFileSync(f, "utf8"));
  return {
    su,
    async drop() {
      await su.end().catch(() => undefined);
      const a = new pg.Client({ connectionString: SUPERUSER_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

const acct = (id: string, user: string, derivId: string, type: "REAL" | "DEMO") =>
  `INSERT INTO deriv_accounts (id, user_id, deriv_account_id, account_type, currency, "group", status) VALUES ('${id}','${user}','${derivId}','${type}','USD','g','active')`;

describe.skipIf(!dbTestsEnabled)("migration " + TARGET + " on existing data", () => {
  it("the migration under test exists and is the last one applied here", () => {
    expect(targetFile).toBeTruthy();
    expect(earlier.length).toBeGreaterThanOrEqual(3);
  });

  describe("backfill", () => {
    let db: Awaited<ReturnType<typeof freshDb>>;
    beforeAll(async () => {
      db = await freshDb();
      await db.su.query(`
        INSERT INTO users (id, email, password_hash) VALUES
          ('real_and_demo', 'a@example.com', 'h'),
          ('demo_only',     'b@example.com', 'h'),
          ('email_only',    'c@example.com', 'h'),
          ('two_reals',     'd@example.com', 'h');
        ${acct("x1", "real_and_demo", "VRTC100", "DEMO")};
        ${acct("x2", "real_and_demo", "CR200", "REAL")};
        ${acct("x3", "demo_only", "VRTC300", "DEMO")};
        ${acct("x4", "two_reals", "CR999", "REAL")};
        ${acct("x5", "two_reals", "CR400", "REAL")};
      `);
      await db.su.query(readFileSync(targetFile, "utf8"));
    });
    afterAll(async () => db?.drop());

    it("picks a REAL account id first, then any account id, then the old email", async () => {
      const { rows } = await db.su.query(`SELECT id, handle FROM users ORDER BY id`);
      expect(Object.fromEntries(rows.map((r) => [r.id, r.handle]))).toEqual({
        real_and_demo: "CR200", // REAL beats the DEMO account that sorts first
        demo_only: "VRTC300",
        email_only: "c@example.com", // never connected Deriv: keeps a unique, non-null handle
        two_reals: "CR400", // several REAL accounts: deterministic (lowest id)
      });
    });

    it("leaves legacy email/password data untouched (expand step, rollback-safe)", async () => {
      const { rows } = await db.su.query(`SELECT email, password_hash FROM users WHERE id = 'demo_only'`);
      expect(rows[0]).toEqual({ email: "b@example.com", password_hash: "h" });
    });

    it("afterwards the constraints hold", async () => {
      await expect(db.su.query(`INSERT INTO users (id) VALUES ('nohandle')`)).rejects.toMatchObject({ code: "23502" });
      await expect(db.su.query(`INSERT INTO users (id, handle) VALUES ('dup', 'CR200')`)).rejects.toMatchObject({ code: "23505" });
      await expect(db.su.query(acct("y1", "demo_only", "CR200", "REAL"))).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("a Deriv account attached to two users", () => {
    let db: Awaited<ReturnType<typeof freshDb>>;
    beforeAll(async () => {
      db = await freshDb();
      await db.su.query(`
        INSERT INTO users (id, email, password_hash) VALUES ('u1', 'a@example.com', 'h'), ('u2', 'b@example.com', 'h');
        ${acct("d1", "u1", "CR777", "REAL")};
        ${acct("d2", "u2", "CR777", "REAL")};
      `);
    });
    afterAll(async () => db?.drop());

    it("stops the migration with a clear message instead of guessing which user keeps it — and changes nothing", async () => {
      await expect(db.su.query(readFileSync(targetFile, "utf8"))).rejects.toThrow(/CR777.*Merge or remove the duplicate users/s);
      const cols = await db.su.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'handle'`);
      expect(cols.rows).toHaveLength(0); // the DO block ran first, so no partial changes
    });
  });
});
