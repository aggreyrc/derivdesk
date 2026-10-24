import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createTestDb, dbTestsEnabled, pgErrorCode, PERMISSION_DENIED, type TestDb } from "./harness.js";
// The REAL store the API uses — not a copy of its SQL.
import { PgLeaseStore } from "../../../apps/api/src/lib/pgLeaseStore.js";

// Runs the production lease statement against a real Postgres as the real `derivdesk_api` role,
// through a thin adapter that turns Prisma's tagged-template calls into parameterised pg queries.

function prismaLike(client: pg.Client) {
  const toQuery = (strings: TemplateStringsArray, values: unknown[]) => ({
    text: strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""), ""),
    values,
  });
  return {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => (await client.query(toQuery(strings, values))).rows,
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => (await client.query(toQuery(strings, values))).rowCount ?? 0,
  } as never;
}

describe.skipIf(!dbTestsEnabled)("runner lease — real Postgres", () => {
  let db: TestDb;
  const clients: pg.Client[] = [];
  const NAME = "bot-runner";

  async function contender() {
    const c = await db.as("derivdesk_api");
    clients.push(c);
    return new PgLeaseStore(prismaLike(c));
  }

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
    await db?.drop();
  });
  const reset = () => db.su.query("DELETE FROM runner_leases");

  it("the first contender gets the lease; a second is refused while it is valid", async () => {
    await reset();
    const a = await contender();
    const b = await contender();
    expect(await a.tryAcquire(NAME, "A", 30_000)).toBe(true);
    expect(await b.tryAcquire(NAME, "B", 30_000)).toBe(false);
    const { rows } = await db.su.query("SELECT holder_id FROM runner_leases WHERE name = $1", [NAME]);
    expect(rows).toEqual([{ holder_id: "A" }]);
  });

  it("the holder can renew; renewal pushes expiry forward and keeps acquired_at", async () => {
    await reset();
    const a = await contender();
    await a.tryAcquire(NAME, "A", 5_000);
    const before = (await db.su.query("SELECT acquired_at, expires_at FROM runner_leases")).rows[0];
    await new Promise((r) => setTimeout(r, 30));
    expect(await a.tryAcquire(NAME, "A", 60_000)).toBe(true);
    const after = (await db.su.query("SELECT acquired_at, expires_at FROM runner_leases")).rows[0];
    expect(after.acquired_at).toEqual(before.acquired_at);
    expect(after.expires_at.getTime()).toBeGreaterThan(before.expires_at.getTime() + 30_000);
  });

  it("a standby takes over once the lease has expired by the DATABASE clock (and not before)", async () => {
    await reset();
    const a = await contender();
    const b = await contender();
    await a.tryAcquire(NAME, "A", 30_000);
    expect(await b.tryAcquire(NAME, "B", 30_000)).toBe(false);
    await db.su.query("UPDATE runner_leases SET expires_at = now() - interval '1 second'"); // A "died"
    expect(await b.tryAcquire(NAME, "B", 30_000)).toBe(true);
    // ...and the old holder can no longer renew it:
    expect(await a.tryAcquire(NAME, "A", 30_000)).toBe(false);
    const { rows } = await db.su.query("SELECT holder_id FROM runner_leases");
    expect(rows).toEqual([{ holder_id: "B" }]);
  });

  it("many processes racing for a free lease: exactly one wins", async () => {
    for (let round = 0; round < 5; round++) {
      await reset();
      const stores = await Promise.all(Array.from({ length: 8 }, () => contender()));
      const results = await Promise.all(stores.map((s, i) => s.tryAcquire(NAME, `P${i}`, 30_000)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const { rows } = await db.su.query("SELECT holder_id FROM runner_leases");
      expect(rows).toHaveLength(1);
      expect(rows[0].holder_id).toBe(`P${results.indexOf(true)}`);
    }
  });

  it("many processes racing for an EXPIRED lease: exactly one wins", async () => {
    await reset();
    await db.su.query("INSERT INTO runner_leases (name, holder_id, expires_at) VALUES ($1, 'dead', now() - interval '1 minute')", [NAME]);
    const stores = await Promise.all(Array.from({ length: 8 }, () => contender()));
    const results = await Promise.all(stores.map((s, i) => s.tryAcquire(NAME, `P${i}`, 30_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("release frees it at once for someone else, but only for the actual holder", async () => {
    await reset();
    const a = await contender();
    const b = await contender();
    await a.tryAcquire(NAME, "A", 30_000);
    await b.release(NAME, "B"); // a non-holder's release must be a no-op
    expect(await b.tryAcquire(NAME, "B", 30_000)).toBe(false);
    await a.release(NAME, "A");
    expect(await b.tryAcquire(NAME, "B", 30_000)).toBe(true);
  });

  it("different lease names are independent", async () => {
    await reset();
    const a = await contender();
    const b = await contender();
    expect(await a.tryAcquire("one", "A", 30_000)).toBe(true);
    expect(await b.tryAcquire("two", "B", 30_000)).toBe(true);
  });

  it("the admin role cannot read or touch the lease table", async () => {
    const admin = await db.as("derivdesk_admin");
    clients.push(admin);
    for (const sql of ["SELECT * FROM runner_leases", "DELETE FROM runner_leases", "UPDATE runner_leases SET holder_id = 'x'"]) {
      expect(await pgErrorCode(admin, sql)).toBe(PERMISSION_DENIED);
    }
  });
});
