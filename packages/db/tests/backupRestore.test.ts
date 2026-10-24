import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, SUPERUSER_URL, createTestDb, dbTestsEnabled, type TestDb } from "./harness.js";

// scripts/backup-db.sh and scripts/restore-db.sh against a real Postgres, in their DIRECT_PG mode
// (same code path as production except how pg_dump/pg_restore are reached: directly instead of through
// `docker compose exec`). Needs pg_dump, pg_restore, psql and python3 on PATH.

const have = (cmd: string) => spawnSync(cmd, ["--version"]).status === 0;
const tools = have("pg_dump") && have("pg_restore") && have("psql") && have("python3");
const suite = dbTestsEnabled && tools ? describe : describe.skip;

suite("backup & restore — real Postgres", () => {
  let db: TestDb;
  let work: string;
  const sourceUrl = () => {
    const u = new URL(SUPERUSER_URL!);
    u.pathname = `/${db.name}`;
    return u.toString();
  };
  const maintenanceUrl = () => {
    const u = new URL(SUPERUSER_URL!);
    u.pathname = "/postgres";
    return u.toString();
  };
  const restored: string[] = [];
  // Only well-formed names we generated are ever scheduled for deletion (a deliberately hostile name
  // used in a refusal test must never reach teardown SQL).
  const track = (name: string) => {
    if (/^dd_restored_[0-9a-f]{6}$/.test(name)) restored.push(name);
  };

  const backup = (extra: Record<string, string> = {}, path?: string) => {
    const r = spawnSync("bash", [join(REPO_ROOT, "scripts", "backup-db.sh")], {
      env: { ...process.env, ...(path ? { PATH: path } : {}), DIRECT_PG: "1", PGURL: sourceUrl(), BACKUP_DIR: join(work, "backups"), ...extra },
      encoding: "utf8",
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const restore = (file: string, target: string, extra: Record<string, string> = {}) => {
    track(target);
    const r = spawnSync("bash", [join(REPO_ROOT, "scripts", "restore-db.sh"), file, target], {
      env: { ...process.env, DIRECT_PG: "1", PGURL: maintenanceUrl(), DERIVDESK_API_DB_PASSWORD: "change_me_api", DERIVDESK_ADMIN_DB_PASSWORD: "change_me_admin", ...extra },
      encoding: "utf8",
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const backupsDir = () => join(work, "backups");
  const latest = () => readdirSync(backupsDir()).filter((f) => f.startsWith("derivdesk-")).sort().pop()!;

  async function inDb(name: string, sql: string) {
    const u = new URL(SUPERUSER_URL!);
    u.pathname = `/${name}`;
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    try {
      return (await c.query(sql)).rows;
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "backup-test-"));
    db = await createTestDb();
    // (these tables' deriv_oauth_tokens / admin_users stay empty on purpose: the backup check must
    // accept empty tables on a young deployment)
    await db.su.query(`
      INSERT INTO users (id, handle) VALUES ('u1', 'CR1'), ('u2', 'CR2');
      INSERT INTO audit_logs (id, actor_type, actor_id, actor_email, action, target_type) VALUES ('al1', 'CLIENT', 'u1', 'CR1', 'test.event', 'x');
    `);
  });
  afterAll(async () => {
    await db?.drop();
    const a = new pg.Client({ connectionString: maintenanceUrl() });
    await a.connect();
    for (const name of restored) await a.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
    await a.end();
    rmSync(work, { recursive: true, force: true });
  });

  it("takes a verified, owner-only backup and a restore reproduces the data and the grants", async () => {
    const b = backup();
    expect(b.code).toBe(0);
    expect(b.out).toMatch(/backup ok/);
    const file = join(backupsDir(), latest());
    expect(statSync(file).mode & 0o777).toBe(0o600); // dumps contain (encrypted) credentials: owner-only

    const target = `dd_restored_${randomBytes(3).toString("hex")}`;
    const r = restore(file, target);
    expect(r.code).toBe(0);

    expect(await inDb(target, "SELECT handle FROM users ORDER BY handle")).toEqual([{ handle: "CR1" }, { handle: "CR2" }]);
    expect((await inDb(target, "SELECT count(*)::int AS n FROM audit_logs"))[0].n).toBe(1);
    // The privilege boundary must survive a restore — the dump carries the grants.
    const boundary = await inDb(
      target,
      `SELECT has_table_privilege('derivdesk_admin','deriv_oauth_tokens','SELECT') AS admin_tokens, has_table_privilege('derivdesk_api','deriv_oauth_tokens','SELECT') AS api_tokens, has_table_privilege('derivdesk_api','audit_logs','UPDATE') AS api_audit_update`,
    );
    expect(boundary[0]).toEqual({ admin_tokens: false, api_tokens: true, api_audit_update: false });
  });

  it("refuses to restore over an existing database", async () => {
    const file = join(backupsDir(), latest());
    const r = restore(file, db.name); // the live test database
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/already exists/);
    expect((await db.su.query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(2); // untouched
  });

  it("rejects an unsafe database name", () => {
    expect(restore(join(backupsDir(), latest()), "x; DROP DATABASE postgres").code).not.toBe(0);
  });

  it("does NOT report success (and leaves no file behind) when pg_dump produces garbage", () => {
    const shimDir = join(work, "badpath");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "pg_dump"), "#!/usr/bin/env bash\necho 'this is not a dump'\n");
    chmodSync(join(shimDir, "pg_dump"), 0o755);
    const before = readdirSync(backupsDir()).length;
    const b = backup({}, `${shimDir}:${process.env.PATH}`);
    expect(b.code).not.toBe(0);
    expect(b.out).toMatch(/BACKUP INVALID/);
    expect(readdirSync(backupsDir()).length).toBe(before); // no .partial, no half-written dump
  });

  it("prunes backups older than BACKUP_KEEP_DAYS and keeps recent ones", () => {
    const old = join(backupsDir(), "derivdesk-20200101T000000Z.dump");
    writeFileSync(old, "old");
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(old, longAgo, longAgo);
    const b = backup({ BACKUP_KEEP_DAYS: "14" });
    expect(b.code).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(b.out).toMatch(/pruned/);
    expect(readdirSync(backupsDir()).filter((f) => f.endsWith(".dump")).length).toBeGreaterThanOrEqual(1);
  });

  (have("gpg") ? it : it.skip)("encrypts to a GPG recipient (no plaintext left) and restores from the encrypted file", async () => {
    const gnupg = mkdtempSync(join(tmpdir(), "gnupg-"));
    chmodSync(gnupg, 0o700);
    const env = { ...process.env, GNUPGHOME: gnupg };
    const gen = spawnSync("gpg", ["--batch", "--passphrase", "", "--quick-gen-key", "backup-test@example.com", "default", "default", "never"], { env, encoding: "utf8" });
    expect(gen.status).toBe(0);

    const dir = join(work, "enc");
    const b = spawnSync("bash", [join(REPO_ROOT, "scripts", "backup-db.sh")], {
      env: { ...env, DIRECT_PG: "1", PGURL: sourceUrl(), BACKUP_DIR: dir, BACKUP_GPG_RECIPIENT: "backup-test@example.com" },
      encoding: "utf8",
    });
    expect(b.status).toBe(0);
    const files = readdirSync(dir);
    expect(files.filter((f) => f.endsWith(".gpg"))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith(".dump"))).toHaveLength(0); // plaintext removed

    const target = `dd_restored_${randomBytes(3).toString("hex")}`;
    track(target);
    const r = spawnSync("bash", [join(REPO_ROOT, "scripts", "restore-db.sh"), join(dir, files[0]!), target], {
      env: { ...env, DIRECT_PG: "1", PGURL: maintenanceUrl(), DERIVDESK_API_DB_PASSWORD: "change_me_api", DERIVDESK_ADMIN_DB_PASSWORD: "change_me_admin" },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect((await inDb(target, "SELECT count(*)::int AS n FROM users"))[0].n).toBe(2);
    rmSync(gnupg, { recursive: true, force: true });
  });
});
