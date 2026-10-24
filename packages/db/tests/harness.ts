import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Database-backed tests run against a REAL PostgreSQL server (the unit tests elsewhere mock the
// database, which cannot catch a wrong grant, a missing unique index, or a migration that does
// not apply). They are opt-in: set TEST_DATABASE_URL to a SUPERUSER connection string for a
// disposable server, e.g. postgresql://postgres@127.0.0.1:5432/postgres. Each test file creates its
// own throw-away database, applies every migration in order and infra/db-init/001_roles.sql
// exactly as a deployment would, and drops it afterwards. Nothing else on the server is touched
// (apart from the two cluster-wide roles the roles script creates, which is idempotent).

export const SUPERUSER_URL = process.env.TEST_DATABASE_URL;
export const dbTestsEnabled = Boolean(SUPERUSER_URL);

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..", "..", "..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "db", "prisma", "migrations");
export const ROLES_SQL = join(REPO_ROOT, "infra", "db-init", "001_roles.sql");
export const PRISMA_SCHEMA = join(REPO_ROOT, "packages", "db", "prisma", "schema.prisma");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort() // timestamp-prefixed, so lexical order == apply order (same as `prisma migrate deploy`)
    .map((name) => join(MIGRATIONS_DIR, name, "migration.sql"));
}

function urlFor(base: string, opts: { database?: string; user?: string; password?: string }): string {
  const u = new URL(base);
  if (opts.database) u.pathname = `/${opts.database}`;
  if (opts.user) u.username = opts.user;
  if (opts.password !== undefined) u.password = opts.password;
  return u.toString();
}

export interface TestDb {
  name: string;
  /** superuser — for seeding and for asserting on catalogs */
  su: pg.Client;
  /** a client connected as one of the application roles, exactly as the deployed service would */
  as(role: "derivdesk_api" | "derivdesk_admin"): Promise<pg.Client>;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const base = SUPERUSER_URL!;
  const name = `dd_test_${randomBytes(5).toString("hex")}`;

  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const su = new pg.Client({ connectionString: urlFor(base, { database: name }) });
  await su.connect();
  for (const file of migrationFiles()) await su.query(readFileSync(file, "utf8"));
  await su.query(readFileSync(ROLES_SQL, "utf8"));
  // Roles are cluster-wide and may already exist with some other password (another test file, a
  // deploy-script test). Pin the known test passwords so these tests never depend on that history.
  await su.query("ALTER ROLE derivdesk_api PASSWORD 'change_me_api'; ALTER ROLE derivdesk_admin PASSWORD 'change_me_admin';");

  const open: pg.Client[] = [];
  return {
    name,
    su,
    async as(role) {
      // The placeholder passwords baked into the roles script (production replaces them).
      const password = role === "derivdesk_api" ? "change_me_api" : "change_me_admin";
      const c = new pg.Client({ connectionString: urlFor(base, { database: name, user: role, password }) });
      await c.connect();
      open.push(c);
      return c;
    },
    async drop() {
      await Promise.all(open.map((c) => c.end().catch(() => undefined)));
      await su.end().catch(() => undefined);
      const a = new pg.Client({ connectionString: base });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Resolves to the Postgres error code (e.g. "42501" permission denied) a statement fails with, or null if it succeeds. */
export async function pgErrorCode(client: pg.Client, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await client.query(sql, params);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

export const PERMISSION_DENIED = "42501";
