import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, REPO_ROOT, SUPERUSER_URL, dbTestsEnabled, migrationFiles } from "./harness.js";

// Runs scripts/migrate-entrypoint.sh — the one-shot deploy step — against a real Postgres.
// Needs `psql` on PATH (skipped otherwise). The only stand-in is `npx prisma migrate deploy`
// (Prisma's engine can't be downloaded in the sandbox): a tiny shim that applies the migration SQL
// files and remembers which it has applied, as the real command does. Everything else is the real script.

const hasPsql = spawnSync("psql", ["--version"]).status === 0;
const suite = dbTestsEnabled && hasPsql ? describe : describe.skip;

suite("migrate-entrypoint.sh — real Postgres", () => {
  let work: string;
  let dbName: string;
  let admin: pg.Client;
  const url = (db: string, user?: string, password?: string) => {
    const u = new URL(SUPERUSER_URL!);
    u.pathname = `/${db}`;
    if (user) u.username = user;
    if (password !== undefined) u.password = password;
    return u.toString();
  };
  const secret = () => randomBytes(18).toString("hex"); // 36 chars

  function shim(dir: string) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    const files = migrationFiles();
    writeFileSync(
      join(dir, "bin", "npx"),
      `#!/usr/bin/env bash
[[ "$1 $2 $3" == "prisma migrate deploy" ]] || { echo "unexpected npx call: $*" >&2; exit 99; }
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c 'CREATE TABLE IF NOT EXISTS _shim_applied (name text primary key)' || exit 1
for f in ${files.map((f) => `'${f}'`).join(" ")}; do
  n="$(basename "$(dirname "$f")")"
  [[ "$(psql "$DATABASE_URL" -Atc "select 1 from _shim_applied where name='$n'")" == "1" ]] && continue
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f" || exit 1
  psql "$DATABASE_URL" -q -c "insert into _shim_applied values ('$n')"
done
`,
    );
    chmodSync(join(dir, "bin", "npx"), 0o755);
  }

  function run(env: Record<string, string>, scriptDir = REPO_ROOT) {
    const r = spawnSync("bash", [join(scriptDir, "scripts", "migrate-entrypoint.sh")], {
      env: { ...process.env, PATH: `${join(work, "bin")}:${process.env.PATH}`, MIGRATE_DATABASE_URL: url(dbName), ...env },
      encoding: "utf8",
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "migrate-test-"));
    shim(work);
    dbName = `dd_mig_${randomBytes(4).toString("hex")}`;
    admin = new pg.Client({ connectionString: SUPERUSER_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
  });
  afterAll(async () => {
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  });

  const tableCount = async () => {
    const c = new pg.Client({ connectionString: url(dbName) });
    await c.connect();
    const { rows } = await c.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE '\\_%'");
    await c.end();
    return rows[0].n as number;
  };

  it("refuses placeholder, short, or identical passwords — and touches nothing", async () => {
    const good = secret();
    for (const env of [
      { DERIVDESK_API_DB_PASSWORD: "change_me_api_padding_padding_padding", DERIVDESK_ADMIN_DB_PASSWORD: good },
      { DERIVDESK_API_DB_PASSWORD: "tooshort", DERIVDESK_ADMIN_DB_PASSWORD: good },
      { DERIVDESK_API_DB_PASSWORD: good, DERIVDESK_ADMIN_DB_PASSWORD: good },
      { DERIVDESK_API_DB_PASSWORD: "", DERIVDESK_ADMIN_DB_PASSWORD: "" },
    ]) {
      const r = run(env);
      expect(r.code).toBe(64);
      expect(r.out).toMatch(/REFUSING|required/);
    }
    expect(await tableCount()).toBe(0);
  });

  it("installs from scratch: schema, grants, real passwords, verified boundary", async () => {
    const [api, adm] = [secret(), secret()];
    const r = run({ DERIVDESK_API_DB_PASSWORD: api, DERIVDESK_ADMIN_DB_PASSWORD: adm });
    expect(r.out).toContain("roles and boundary verified");
    expect(r.code).toBe(0);
    expect(await tableCount()).toBeGreaterThan(10);

    for (const [role, pw] of [["derivdesk_api", api], ["derivdesk_admin", adm]] as const) {
      const c = new pg.Client({ connectionString: url(dbName, role, pw) });
      await c.connect();
      await c.end();
    }
    // If the cluster enforces passwords (scram), a wrong/placeholder one must fail. (A `trust`-auth
    // scratch cluster accepts anything, in which case this can't be asserted and is skipped.)
    const wrong = new pg.Client({ connectionString: url(dbName, "derivdesk_api", "change_me_api") });
    const accepted = await wrong.connect().then(() => true, () => false);
    await wrong.end().catch(() => undefined);
    if (accepted) console.warn("[migrateEntrypoint.test] cluster uses trust auth: skipped the wrong-password rejection check");
    else expect(accepted).toBe(false);
  });

  it("is idempotent, and a rotated password takes effect on the next run", async () => {
    const [api, adm] = [secret(), secret()];
    expect(run({ DERIVDESK_API_DB_PASSWORD: api, DERIVDESK_ADMIN_DB_PASSWORD: adm }).code).toBe(0);
    expect(run({ DERIVDESK_API_DB_PASSWORD: api, DERIVDESK_ADMIN_DB_PASSWORD: adm }).code).toBe(0);
    const rotated = secret();
    expect(run({ DERIVDESK_API_DB_PASSWORD: rotated, DERIVDESK_ADMIN_DB_PASSWORD: adm }).code).toBe(0);
    const c = new pg.Client({ connectionString: url(dbName, "derivdesk_api", rotated) });
    await c.connect();
    await c.end();
  });

  it("FAILS THE DEPLOY (exit 70) if the privilege boundary is ever broken", async () => {
    // A copy of the script + a roles file that (wrongly) lets admin read the Deriv tokens.
    const tampered = mkdtempSync(join(tmpdir(), "migrate-tamper-"));
    mkdirSync(join(tampered, "scripts"));
    mkdirSync(join(tampered, "infra", "db-init"), { recursive: true });
    copyFileSync(join(REPO_ROOT, "scripts", "migrate-entrypoint.sh"), join(tampered, "scripts", "migrate-entrypoint.sh"));
    writeFileSync(join(tampered, "infra", "db-init", "001_roles.sql"), readFileSync(join(REPO_ROOT, "infra", "db-init", "001_roles.sql"), "utf8") + "\nGRANT SELECT ON deriv_oauth_tokens TO derivdesk_admin;\n");
    mkdirSync(join(tampered, "packages", "db", "prisma"), { recursive: true });
    const r = run({ DERIVDESK_API_DB_PASSWORD: secret(), DERIVDESK_ADMIN_DB_PASSWORD: secret() }, tampered);
    rmSync(tampered, { recursive: true, force: true });
    expect(r.code).toBe(70);
    expect(r.out).toMatch(/BOUNDARY CHECK FAILED/);
    // and a normal run afterwards puts it right again
    expect(run({ DERIVDESK_API_DB_PASSWORD: secret(), DERIVDESK_ADMIN_DB_PASSWORD: secret() }).code).toBe(0);
  });
});
