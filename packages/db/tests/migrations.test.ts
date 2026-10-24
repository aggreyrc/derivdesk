import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRISMA_SCHEMA, ROLES_SQL, createTestDb, dbTestsEnabled, migrationFiles, type TestDb } from "./harness.js";
import { parseSchema } from "./schemaParser.js";

const schema = parseSchema(PRISMA_SCHEMA);
const ACTION: Record<string, string> = { Cascade: "c", Restrict: "r", SetNull: "n", NoAction: "a" };

describe.skipIf(!dbTestsEnabled)("migrations against a real PostgreSQL", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb(); // applies every migration in order, then the roles script
  });
  afterAll(async () => db?.drop());

  it("found at least the three known migrations, and the schema parser found the models", () => {
    expect(migrationFiles().length).toBeGreaterThanOrEqual(3);
    expect(schema.models.length).toBeGreaterThanOrEqual(15);
  });

  it("the roles script is idempotent (safe to re-run after every migration, as the README says)", async () => {
    await expect(db.su.query(readFileSync(ROLES_SQL, "utf8"))).resolves.toBeTruthy();
    await expect(db.su.query(readFileSync(ROLES_SQL, "utf8"))).resolves.toBeTruthy();
  });

  it("every Prisma model has a table with exactly the columns the schema declares, and nothing else", async () => {
    const { rows } = await db.su.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const actual = new Map<string, Set<string>>();
    for (const r of rows) (actual.get(r.table_name) ?? actual.set(r.table_name, new Set()).get(r.table_name)!).add(r.column_name);

    const problems: string[] = [];
    for (const m of schema.models) {
      const cols = actual.get(m.table);
      if (!cols) {
        problems.push(`missing table ${m.table}`);
        continue;
      }
      const expected = new Set(m.fields.map((f) => f.column));
      for (const c of expected) if (!cols.has(c)) problems.push(`${m.table}: missing column ${c}`);
      for (const c of cols) if (!expected.has(c)) problems.push(`${m.table}: unexpected column ${c}`);
    }
    const modelTables = new Set(schema.models.map((m) => m.table));
    for (const t of actual.keys()) if (!modelTables.has(t) && !t.startsWith("admin_visible")) problems.push(`table/view ${t} has no Prisma model`);
    expect(problems).toEqual([]);
  });

  it("nullability matches the schema (required => NOT NULL, optional => nullable)", async () => {
    const { rows } = await db.su.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const nullable = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable === "YES"]));
    const problems: string[] = [];
    for (const m of schema.models)
      for (const f of m.fields) {
        const actual = nullable.get(`${m.table}.${f.column}`);
        if (actual === undefined) continue; // reported by the column test
        if (actual !== f.optional) problems.push(`${m.table}.${f.column}: schema ${f.optional ? "optional" : "required"} but column is ${actual ? "nullable" : "NOT NULL"}`);
      }
    expect(problems).toEqual([]);
  });

  it("enum types hold exactly the values the schema declares", async () => {
    const { rows } = await db.su.query<{ typname: string; enumlabel: string }>(
      `SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ORDER BY t.typname, e.enumsortorder`,
    );
    const actual: Record<string, string[]> = {};
    for (const r of rows) (actual[r.typname] ??= []).push(r.enumlabel);
    for (const [name, values] of Object.entries(schema.enums)) expect(actual[name], `enum ${name}`).toEqual(values);
  });

  it("every unique constraint / @unique / @@unique in the schema exists as a unique index (the code's upserts depend on them)", async () => {
    const { rows } = await db.su.query<{ table_name: string; cols: string[] }>(
      `SELECT c.relname AS table_name,
              ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS cols
       FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND i.indisunique`,
    );
    const have = rows.map((r) => `${r.table_name}(${[...r.cols].sort().join(",")})`);
    const problems: string[] = [];
    for (const m of schema.models) {
      for (const u of m.uniques) if (!have.includes(`${m.table}(${[...u].sort().join(",")})`)) problems.push(`${m.table}: no unique index on (${u.join(", ")})`);
      const id = m.fields.filter((f) => f.isId).map((f) => f.column);
      if (id.length && !have.includes(`${m.table}(${[...id].sort().join(",")})`)) problems.push(`${m.table}: no primary key on (${id.join(", ")})`);
    }
    expect(problems).toEqual([]);
  });

  it("every foreign key exists with the delete behaviour the schema asks for (cascade / restrict / set null)", async () => {
    const { rows } = await db.su.query<{ child: string; col: string; parent: string; action: string }>(
      `SELECT cl.relname AS child, a.attname AS col, pr.relname AS parent, c.confdeltype AS action
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_class pr ON pr.oid = c.confrelid
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f'`,
    );
    const have = new Map(rows.map((r) => [`${r.child}.${r.col}->${r.parent}`, r.action]));
    const problems: string[] = [];
    for (const m of schema.models)
      for (const r of m.relations) {
        const key = `${m.table}.${r.column}->${r.targetTable}`;
        const action = have.get(key);
        if (action === undefined) problems.push(`missing foreign key ${key}`);
        else if (action !== ACTION[r.onDelete]) problems.push(`${key}: schema says ${r.onDelete}, database has '${action}'`);
      }
    expect(problems).toEqual([]);
  });

  it("every @@index in the schema exists", async () => {
    const { rows } = await db.su.query<{ table_name: string; cols: string[] }>(
      `SELECT c.relname AS table_name,
              ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS cols
       FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`,
    );
    const have = rows.map((r) => `${r.table_name}(${r.cols.join(",")})`);
    const problems: string[] = [];
    for (const m of schema.models)
      for (const idx of m.indexes) if (!have.some((h) => h.startsWith(`${m.table}(${idx.join(",")}`))) problems.push(`${m.table}: no index starting with (${idx.join(", ")})`);
    expect(problems).toEqual([]);
  });
});
