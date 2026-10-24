import { describe, expect, it, vi } from "vitest";
import { RunnerLease, type LeaseStore } from "../runnerLease.js";

// A fake store that behaves like the SQL: one holder at a time, expiry on a shared "database" clock.
function fakeDb() {
  const db = { holder: null as string | null, expiresAt: 0, now: 0, failing: false, hang: null as null | Promise<void> };
  const store: LeaseStore = {
    async tryAcquire(_name, holderId, ttlMs) {
      if (db.hang) await db.hang;
      if (db.failing) throw new Error("db down");
      if (db.holder === holderId || db.holder === null || db.expiresAt < db.now) {
        db.holder = holderId;
        db.expiresAt = db.now + ttlMs;
        return true;
      }
      return false;
    },
    async release(_n, holderId) {
      if (db.holder === holderId) db.holder = null;
    },
  };
  return { db, store };
}

function make(store: LeaseStore, clock: { t: number }, id: string, hooks: { acquired?: () => void; lost?: (r: string) => void } = {}) {
  return new RunnerLease({
    store,
    name: "bot-runner",
    ttlMs: 30_000,
    holderId: id,
    nowMs: () => clock.t,
    onAcquired: hooks.acquired ?? (() => undefined),
    onLost: hooks.lost ?? (() => undefined),
  });
}

describe("RunnerLease", () => {
  it("only one of two contenders becomes leader; the standby is not", async () => {
    const { store } = fakeDb();
    const clock = { t: 0 };
    const a = make(store, clock, "A");
    const b = make(store, clock, "B");
    await a.tick();
    await b.tick();
    expect(a.isHeld()).toBe(true);
    expect(b.isHeld()).toBe(false);
  });

  it("calls onAcquired once, however many renewals follow", async () => {
    const { store } = fakeDb();
    const clock = { t: 0 };
    const acquired = vi.fn();
    const a = make(store, clock, "A", { acquired });
    for (let i = 0; i < 5; i++) {
      clock.t += 10_000;
      await a.tick();
    }
    expect(acquired).toHaveBeenCalledTimes(1);
    expect(a.isHeld()).toBe(true);
  });

  it("a standby takes over after the leader dies and its lease expires — never before", async () => {
    const { db, store } = fakeDb();
    const clock = { t: 0 };
    const a = make(store, clock, "A");
    const b = make(store, clock, "B");
    await a.tick(); // A leads, lease expires at 30_000 (database clock)
    // A dies (stops renewing). B polls while the lease is still valid:
    db.now = 29_000;
    clock.t = 29_000;
    await b.tick();
    expect(b.isHeld()).toBe(false);
    db.now = 30_001;
    clock.t = 30_001;
    await b.tick();
    expect(b.isHeld()).toBe(true);
  });

  it("the old leader stops BEFORE a standby can take over when it cannot reach the database", async () => {
    const { db, store } = fakeDb();
    const clock = { t: 0 };
    const lost = vi.fn();
    const a = make(store, clock, "A", { lost });
    await a.tick();
    expect(a.isHeld()).toBe(true);

    db.failing = true; // network partition: renewals fail
    clock.t = 10_000;
    await a.tick(); // still inside validity (25s = ttl - ttl/6)
    expect(a.isHeld()).toBe(true);
    expect(lost).not.toHaveBeenCalled();

    clock.t = 25_001; // validity ends 5s BEFORE the DB lease (30s) could be taken by another process
    expect(a.isHeld()).toBe(false); // isHeld() alone is already false: trading is gated even before tick runs
    await a.tick();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost.mock.calls[0]![0]).toMatch(/renew/i);
  });

  it("a hung renewal request cannot keep a process leader past its validity (watchdog)", async () => {
    const { db, store } = fakeDb();
    const clock = { t: 0 };
    const lost = vi.fn();
    const a = make(store, clock, "A", { lost });
    await a.tick();
    let release!: () => void;
    db.hang = new Promise<void>((r) => (release = r));
    const hung = a.tick(); // request in flight, never answers
    clock.t = 26_000;
    await a.tick(); // second tick: the watchdog must act even though the first is still pending
    expect(lost).toHaveBeenCalledTimes(1);
    expect(a.isHeld()).toBe(false);
    release();
    await hung;
  });

  it("loses leadership when another process holds the lease at renewal, and can regain it later", async () => {
    const { db, store } = fakeDb();
    const clock = { t: 0 };
    const lost = vi.fn();
    const acquired = vi.fn();
    const a = make(store, clock, "A", { lost, acquired });
    await a.tick();
    db.holder = "B"; // someone else got it (e.g. we were frozen past expiry)
    db.expiresAt = 100_000;
    clock.t = 10_000;
    db.now = 10_000;
    await a.tick();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(a.isHeld()).toBe(false);

    db.holder = null; // B released
    clock.t = 20_000;
    await a.tick();
    expect(a.isHeld()).toBe(true);
    expect(acquired).toHaveBeenCalledTimes(2);
  });

  it("stop() ends leadership, notifies, and releases the lease so a standby can lead immediately", async () => {
    const { db, store } = fakeDb();
    const clock = { t: 0 };
    const lost = vi.fn();
    const a = make(store, clock, "A", { lost });
    const b = make(store, clock, "B");
    await a.tick();
    await a.stop();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(db.holder).toBeNull();
    await b.tick(); // no waiting for expiry
    expect(b.isHeld()).toBe(true);
  });

  it("a standby that shuts down does not release the real leader's lease", async () => {
    const { db, store } = fakeDb();
    const clock = { t: 0 };
    const a = make(store, clock, "A");
    const b = make(store, clock, "B");
    await a.tick();
    await b.tick();
    await b.stop();
    expect(db.holder).toBe("A");
  });

  it("if starting the runner fails after acquiring, it gives the lease back instead of squatting on it", async () => {
    const { db, store } = fakeDb();
    const clock = { t: 0 };
    const a = make(store, clock, "A", {
      acquired: () => {
        throw new Error("boom");
      },
    });
    await a.tick();
    expect(a.isHeld()).toBe(false);
    expect(db.holder).toBeNull();
  });

  it("refuses a ttl too short to renew safely", () => {
    const { store } = fakeDb();
    expect(() => new RunnerLease({ store, name: "x", ttlMs: 1000, onAcquired: () => undefined, onLost: () => undefined })).toThrow(/ttl/);
  });
});
