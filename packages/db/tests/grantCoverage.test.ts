import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRISMA_SCHEMA, REPO_ROOT, createTestDb, dbTestsEnabled, type TestDb } from "./harness.js";
import { parseSchema } from "./schemaParser.js";

// The role grants (infra/db-init/001_roles.sql) and the application code are written separately,
// so they can disagree — and a disagreement only shows up in production as "permission denied" the
// first time that code path runs (this is exactly how a missing INSERT on feature_flags and a
// missing DELETE on admin_sessions were found). This test closes that gap mechanically: it scans
// each app's source for every Prisma call, translates it to the SQL privileges it needs, and asks
// Postgres whether the app's role really has them.

type Priv = "SELECT" | "INSERT" | "UPDATE" | "DELETE";
const NEEDS: Record<string, Priv[]> = {
  findUnique: ["SELECT"],
  findUniqueOrThrow: ["SELECT"],
  findFirst: ["SELECT"],
  findFirstOrThrow: ["SELECT"],
  findMany: ["SELECT"],
  count: ["SELECT"],
  aggregate: ["SELECT"],
  groupBy: ["SELECT"],
  create: ["INSERT", "SELECT"], // Prisma reads the new row back (RETURNING)
  createMany: ["INSERT"],
  update: ["UPDATE", "SELECT"], // the WHERE clause reads columns
  updateMany: ["UPDATE", "SELECT"],
  upsert: ["INSERT", "UPDATE", "SELECT"],
  delete: ["DELETE", "SELECT"],
  deleteMany: ["DELETE", "SELECT"],
};

const APPS: Array<{ dir: string; role: string; label: string }> = [
  { dir: "apps/api/src", role: "derivdesk_api", label: "apps/api" },
  { dir: "apps/admin-api/src", role: "derivdesk_admin", label: "apps/admin-api" },
  { dir: "apps/admin-api/scripts", role: "derivdesk_admin", label: "apps/admin-api scripts" },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...sourceFiles(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const schema = parseSchema(PRISMA_SCHEMA);
const tableByDelegate = new Map(schema.models.map((m) => [m.name[0]!.toLowerCase() + m.name.slice(1), m.table]));

interface Use {
  file: string;
  table: string;
  op: string;
}

function usesIn(dir: string): Use[] {
  const uses: Use[] = [];
  const re = new RegExp(`\\b(?:prisma|db|tx)\\s*\\.\\s*(\\w+)\\s*\\.\\s*(${Object.keys(NEEDS).join("|")})\\s*[(<]`, "g");
  for (const file of sourceFiles(join(REPO_ROOT, dir))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(re)) {
      const table = tableByDelegate.get(m[1]!);
      if (table) uses.push({ file: file.replace(REPO_ROOT + "/", ""), table, op: m[2]! });
    }
  }
  return uses;
}

describe.skipIf(!dbTestsEnabled)("every database call in the apps is permitted by that app's role", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => db?.drop());

  for (const app of APPS) {
    it(`${app.label} (as ${app.role})`, async () => {
      const uses = usesIn(app.dir);
      expect(uses.length, "the scanner should find Prisma calls in this app").toBeGreaterThan(0);

      const problems = new Set<string>();
      for (const u of uses) {
        for (const priv of NEEDS[u.op]!) {
          const { rows } = await db.su.query<{ ok: boolean }>(`SELECT has_table_privilege($1, $2, $3) AS ok`, [app.role, `public.${u.table}`, priv]);
          if (!rows[0]!.ok) problems.add(`${app.role} lacks ${priv} on ${u.table} — needed by ${u.op}() in ${u.file}`);
        }
      }
      expect([...problems].sort()).toEqual([]);
    });
  }

  it("sanity: the scanner understands multi-line chains and the delegate→table mapping", () => {
    const uses = usesIn("apps/api/src");
    expect(uses.some((u) => u.table === "local_trades" && u.op === "upsert")).toBe(true); // `prisma.localTrade\n .upsert(`
    expect(uses.some((u) => u.table === "bot_instances" && u.op === "findMany")).toBe(true);
    expect(usesIn("apps/admin-api/src").some((u) => u.table === "feature_flags" && u.op === "upsert")).toBe(true);
  });
});
