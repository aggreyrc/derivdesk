import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKeyring, encryptWithKey } from "../crypto.js";
import { rotateTotpKeys, type AdminTotpRow, type RotationDb } from "../keyRotation.js";
import { sealTotpState, unsealTotpState } from "../totpState.js";

const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const keyring = createKeyring(newKey, [oldKey]);

function fakeDb(initial: AdminTotpRow[], onUpdate?: (rows: AdminTotpRow[]) => void) {
  const rows = initial.map((r) => ({ ...r }));
  const db: RotationDb = {
    adminUser: {
      async findMany({ where, take }) {
        return rows.filter((r) => r.totpSecretEnc !== null && (!where.id || r.id > where.id.gt)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, take).map((r) => ({ ...r }));
      },
      async updateMany({ where, data }) {
        onUpdate?.(rows);
        const row = rows.find((r) => r.id === where.id && r.totpSecretEnc === where.totpSecretEnc);
        if (!row) return { count: 0 };
        row.totpSecretEnc = data.totpSecretEnc;
        return { count: 1 };
      },
    },
  };
  return { db, rows };
}
const state = (secret: string, lastStep: number) => encryptWithKey(JSON.stringify({ v: 1, secret, lastStep }), oldKey);

describe("rotateTotpKeys", () => {
  it("re-seals under the new key and preserves the secret AND the replay counter exactly", async () => {
    const { db, rows } = fakeDb([{ id: "a", totpSecretEnc: state("JBSWY3DPEHPK3PXP", 12345) }, { id: "none", totpSecretEnc: null }]);
    const report = await rotateTotpKeys(db, keyring);
    expect(report).toMatchObject({ scanned: 1, rotated: 1, raced: 0, undecryptableRowIds: [] });
    const only = createKeyring(newKey);
    expect(JSON.parse(only.decrypt(rows[0]!.totpSecretEnc!))).toEqual({ v: 1, secret: "JBSWY3DPEHPK3PXP", lastStep: 12345 });
    expect(rows[1]!.totpSecretEnc).toBeNull(); // never-enrolled admins are skipped
  });

  it("works on blobs produced by the app's own sealTotpState, and the app (still on the old key) can no longer open them afterwards", async () => {
    // The app's module-level key is the test ADMIN_TOTP_ENCRYPTION_KEY; treat it as the "old" key.
    const appKey = Buffer.from("MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=", "base64");
    const sealed = sealTotpState({ v: 1, secret: "ABCDEFGH", lastStep: 77 });
    const { db, rows } = fakeDb([{ id: "a", totpSecretEnc: sealed }]);
    await rotateTotpKeys(db, createKeyring(newKey, [appKey]));
    expect(JSON.parse(createKeyring(newKey).decrypt(rows[0]!.totpSecretEnc!))).toEqual({ v: 1, secret: "ABCDEFGH", lastStep: 77 });
    // This is exactly why the procedure forbids re-encrypting before every instance runs the new key:
    expect(() => unsealTotpState(rows[0]!.totpSecretEnc!)).toThrow();
  });

  it("is idempotent, and dry-run writes nothing", async () => {
    const { db, rows } = fakeDb([{ id: "a", totpSecretEnc: state("S", 1) }]);
    const before = JSON.stringify(rows);
    expect((await rotateTotpKeys(db, keyring, { dryRun: true })).rotated).toBe(1);
    expect(JSON.stringify(rows)).toBe(before);
    await rotateTotpKeys(db, keyring);
    expect(await rotateTotpKeys(db, keyring)).toMatchObject({ alreadyCurrent: 1, rotated: 0 });
  });

  it("does not clobber a login that advanced the replay counter mid-rotation", async () => {
    const advanced = encryptWithKey(JSON.stringify({ v: 1, secret: "S", lastStep: 999 }), newKey);
    const { db, rows } = fakeDb([{ id: "a", totpSecretEnc: state("S", 1) }], (r) => {
      r[0]!.totpSecretEnc = advanced;
    });
    const report = await rotateTotpKeys(db, keyring);
    expect(report.raced).toBe(1);
    expect(rows[0]!.totpSecretEnc).toBe(advanced);
  });

  it("reports an unreadable value by id only and leaves it alone", async () => {
    const stray = encryptWithKey("x", randomBytes(32));
    const { db, rows } = fakeDb([{ id: "bad", totpSecretEnc: stray }]);
    const report = await rotateTotpKeys(db, keyring);
    expect(report.undecryptableRowIds).toEqual(["bad"]);
    expect(rows[0]!.totpSecretEnc).toBe(stray);
  });
});
