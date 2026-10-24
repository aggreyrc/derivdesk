import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKeyring, encryptWithKey } from "../crypto.js";
import { rotateTokenKeys, type RotationDb, type TokenRow } from "../keyRotation.js";

const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const strayKey = randomBytes(32);
const keyring = createKeyring(newKey, [oldKey]); // after step 2 of the procedure: new encrypts, old still decrypts

function fakeDb(initial: TokenRow[], opts: { onUpdate?: (rows: TokenRow[]) => void } = {}) {
  const rows = initial.map((r) => ({ ...r }));
  const db: RotationDb = {
    derivOAuthToken: {
      async findMany({ where, take }) {
        return rows.filter((r) => !where || r.id > where.id.gt).sort((a, b) => a.id.localeCompare(b.id)).slice(0, take).map((r) => ({ ...r }));
      },
      async updateMany({ where, data }) {
        opts.onUpdate?.(rows);
        const row = rows.find((r) => r.id === where.id && r.accessTokenEnc === where.accessTokenEnc && r.refreshTokenEnc === where.refreshTokenEnc);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  return { db, rows };
}

const row = (id: string, access: string, refresh: string | null): TokenRow => ({ id, accessTokenEnc: encryptWithKey(access, oldKey), refreshTokenEnc: refresh === null ? null : encryptWithKey(refresh, oldKey) });

describe("rotateTokenKeys", () => {
  it("re-encrypts old-key values under the new key, preserving the plaintext", async () => {
    const { db, rows } = fakeDb([row("a", "acc-1", "ref-1"), row("b", "acc-2", null)]);
    const report = await rotateTokenKeys(db, keyring);
    expect(report).toMatchObject({ scanned: 2, rotated: 2, alreadyCurrent: 0, raced: 0, undecryptableRowIds: [] });
    const only = createKeyring(newKey); // the old key is now retired
    expect(only.decrypt(rows[0]!.accessTokenEnc)).toBe("acc-1");
    expect(only.decrypt(rows[0]!.refreshTokenEnc!)).toBe("ref-1");
    expect(only.decrypt(rows[1]!.accessTokenEnc)).toBe("acc-2");
    expect(rows[1]!.refreshTokenEnc).toBeNull();
  });

  it("is idempotent: a second run changes nothing", async () => {
    const { db, rows } = fakeDb([row("a", "acc-1", "ref-1")]);
    await rotateTokenKeys(db, keyring);
    const snapshot = JSON.stringify(rows);
    const second = await rotateTokenKeys(db, keyring);
    expect(second).toMatchObject({ scanned: 1, rotated: 0, alreadyCurrent: 1 });
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it("dry-run reports what it would do and writes nothing", async () => {
    const { db, rows } = fakeDb([row("a", "acc-1", "ref-1")]);
    const before = JSON.stringify(rows);
    const report = await rotateTokenKeys(db, keyring, { dryRun: true });
    expect(report.rotated).toBe(1);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("handles a row where only one of the two values is still under the old key", async () => {
    const mixed: TokenRow = { id: "m", accessTokenEnc: encryptWithKey("acc", newKey), refreshTokenEnc: encryptWithKey("ref", oldKey) };
    const { db, rows } = fakeDb([mixed]);
    const accessBefore = rows[0]!.accessTokenEnc;
    await rotateTokenKeys(db, keyring);
    expect(rows[0]!.accessTokenEnc).toBe(accessBefore); // untouched, not needlessly re-encrypted
    expect(createKeyring(newKey).decrypt(rows[0]!.refreshTokenEnc!)).toBe("ref");
  });

  it("reports a value NO key can open by row id only, leaves it untouched, and carries on", async () => {
    const bad: TokenRow = { id: "bad", accessTokenEnc: encryptWithKey("lost", strayKey), refreshTokenEnc: null };
    const { db, rows } = fakeDb([bad, row("good", "acc", "ref")]);
    const report = await rotateTokenKeys(db, keyring);
    expect(report.undecryptableRowIds).toEqual(["bad"]);
    expect(report.rotated).toBe(1);
    expect(rows.find((r) => r.id === "bad")!.accessTokenEnc).toBe(bad.accessTokenEnc);
    expect(JSON.stringify(report)).not.toMatch(/lost|v1\./); // no ciphertext or plaintext in the report
  });

  it("never overwrites a token the app refreshed while rotation was running (compare-and-set)", async () => {
    const fresh = encryptWithKey("brand-new-token", newKey);
    const { db, rows } = fakeDb([row("a", "acc-1", "ref-1")], {
      onUpdate: (current) => {
        current[0]!.accessTokenEnc = fresh; // the app refreshed the token between our read and write
      },
    });
    const report = await rotateTokenKeys(db, keyring);
    expect(report.raced).toBe(1);
    expect(report.rotated).toBe(0);
    expect(rows[0]!.accessTokenEnc).toBe(fresh); // the app's newer value survived
  });

  it("pages through more rows than one batch", async () => {
    const many = Array.from({ length: 25 }, (_, i) => row(`r${String(i).padStart(3, "0")}`, `a${i}`, `r${i}`));
    const { db } = fakeDb(many);
    const report = await rotateTokenKeys(db, keyring, { batchSize: 10 });
    expect(report).toMatchObject({ scanned: 25, rotated: 25 });
  });
});

describe("keyring", () => {
  it("encrypts with the current key only, decrypts with current or extra keys", () => {
    const k = createKeyring(newKey, [oldKey]);
    expect(createKeyring(newKey).decrypt(k.encrypt("x"))).toBe("x");
    expect(() => createKeyring(oldKey).decrypt(k.encrypt("x"))).toThrow();
    expect(k.decrypt(encryptWithKey("legacy", oldKey))).toBe("legacy");
  });
  it("a wrong key can never return a wrong plaintext — only an error", () => {
    expect(() => createKeyring(strayKey).decrypt(encryptWithKey("secret", oldKey))).toThrow(/any configured key/);
  });
  it("isCurrent distinguishes keys without leaking which one matched", () => {
    const k = createKeyring(newKey, [oldKey]);
    expect(k.isCurrent(encryptWithKey("a", newKey))).toBe(true);
    expect(k.isCurrent(encryptWithKey("a", oldKey))).toBe(false);
  });
});
