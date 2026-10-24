import { describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@derivdesk/db";
import { LoginFailure, authenticateAdmin } from "./auth.service.js";
import { hashPassword } from "../../lib/password.js";
import { hotp, base32Decode, totpStep } from "../../lib/totp.js";
import { sealTotpState, unsealTotpState } from "../../lib/totpState.js";

const PASSWORD = "correct-horse-battery-staple";
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const NOW = 1_800_000_000_000;
const codeAt = (offsetSteps = 0) => hotp(base32Decode(SECRET), totpStep(NOW) + offsetSteps);

/** An in-memory stand-in for the admin_users table that implements the compare-and-set that
 *  updateMany({where:{id,totpSecretEnc}}) performs in Postgres. */
async function fakeDb(row: Partial<{ totpSecretEnc: string | null; status: string }> = {}) {
  const admin = {
    id: "admin_1",
    email: "ops@example.com",
    passwordHash: await hashPassword(PASSWORD),
    status: "ACTIVE",
    totpSecretEnc: null as string | null,
    ...row,
  };
  const updateMany = vi.fn(async ({ where, data }: { where: { id: string; totpSecretEnc: string }; data: { totpSecretEnc: string } }) => {
    if (where.id === admin.id && where.totpSecretEnc === admin.totpSecretEnc) {
      admin.totpSecretEnc = data.totpSecretEnc;
      return { count: 1 };
    }
    return { count: 0 };
  });
  const db = { adminUser: { findUnique: vi.fn(async () => ({ ...admin })), updateMany } } as unknown as PrismaClient;
  return { db, admin, updateMany };
}

const enrolled = (lastStep: number | null = null) => sealTotpState({ v: 1, secret: SECRET, lastStep });
const opts = { requireTotp: true, now: () => NOW };

async function failure(p: Promise<unknown>): Promise<LoginFailure> {
  try {
    await p;
  } catch (e) {
    if (e instanceof LoginFailure) return e;
    throw e;
  }
  throw new Error("expected a LoginFailure");
}

describe("authenticateAdmin — password stage", () => {
  it("rejects a wrong password", async () => {
    const { db } = await fakeDb({ totpSecretEnc: enrolled() });
    expect(await failure(authenticateAdmin(db, "ops@example.com", "wrong", codeAt(), opts))).toMatchObject({ status: 401, reason: "bad_password" });
  });

  it("rejects an unknown email identically, after burning a bcrypt comparison (no timing oracle)", async () => {
    const spy = vi.spyOn(bcrypt, "compare");
    const db = { adminUser: { findUnique: vi.fn().mockResolvedValue(null) } } as unknown as PrismaClient;
    const f = await failure(authenticateAdmin(db, "nobody@example.com", "x", undefined, opts));
    expect(f).toMatchObject({ status: 401, code: "InvalidCredentials", adminId: null, reason: "unknown_account" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("rejects a disabled admin even with a correct password and code", async () => {
    const { db } = await fakeDb({ status: "DISABLED", totpSecretEnc: enrolled() });
    expect(await failure(authenticateAdmin(db, "ops@example.com", PASSWORD, codeAt(), opts))).toMatchObject({ status: 403, reason: "disabled" });
  });
});

describe("authenticateAdmin — two-factor stage", () => {
  it("accepts a correct password + current code, and records the step so it cannot be reused", async () => {
    const { db, admin } = await fakeDb({ totpSecretEnc: enrolled() });
    await expect(authenticateAdmin(db, "ops@example.com", PASSWORD, codeAt(), opts)).resolves.toMatchObject({ id: "admin_1" });
    expect(unsealTotpState(admin.totpSecretEnc!).lastStep).toBe(totpStep(NOW));
  });

  it("asks for the code (without it counting as a bad guess) when the password is right but no code was sent", async () => {
    const { db } = await fakeDb({ totpSecretEnc: enrolled() });
    expect(await failure(authenticateAdmin(db, "ops@example.com", PASSWORD, undefined, opts))).toMatchObject({ status: 401, code: "TotpRequired", reason: "totp_missing" });
  });

  it("rejects a wrong code", async () => {
    const { db } = await fakeDb({ totpSecretEnc: enrolled() });
    const wrong = codeAt() === "000000" ? "000001" : "000000";
    expect(await failure(authenticateAdmin(db, "ops@example.com", PASSWORD, wrong, opts))).toMatchObject({ status: 401, code: "InvalidTotp", reason: "bad_totp" });
  });

  it("rejects a code from far outside the drift window", async () => {
    const { db } = await fakeDb({ totpSecretEnc: enrolled() });
    expect(await failure(authenticateAdmin(db, "ops@example.com", PASSWORD, codeAt(5), opts))).toMatchObject({ reason: "bad_totp" });
  });

  it("accepts a code from the adjacent step (phone clock drift)", async () => {
    const { db } = await fakeDb({ totpSecretEnc: enrolled() });
    await expect(authenticateAdmin(db, "ops@example.com", PASSWORD, codeAt(-1), opts)).resolves.toBeTruthy();
  });

  it("refuses to replay a code that was already used (even though it is still inside its window)", async () => {
    const { db } = await fakeDb({ totpSecretEnc: enrolled() });
    await authenticateAdmin(db, "ops@example.com", PASSWORD, codeAt(), opts);
    expect(await failure(authenticateAdmin(db, "ops@example.com", PASSWORD, codeAt(), opts))).toMatchObject({ reason: "totp_replay" });
  });

  it("refuses an OLDER code once a newer one has been used", async () => {
    const { db } = await fakeDb({ totpSecretEnc: enrolled(totpStep(NOW)) });
    expect(await failure(authenticateAdmin(db, "ops@example.com", PASSWORD, codeAt(-1), opts))).toMatchObject({ reason: "totp_replay" });
  });

  it("lets only ONE of two concurrent logins with the same code succeed (atomic compare-and-set)", async () => {
    const { db } = await fakeDb({ totpSecretEnc: enrolled() });
    const results = await Promise.allSettled([
      authenticateAdmin(db, "ops@example.com", PASSWORD, codeAt(), opts),
      authenticateAdmin(db, "ops@example.com", PASSWORD, codeAt(), opts),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("fails CLOSED when 2FA is required and the admin has not enrolled", async () => {
    const { db } = await fakeDb({ totpSecretEnc: null });
    expect(await failure(authenticateAdmin(db, "ops@example.com", PASSWORD, undefined, opts))).toMatchObject({ status: 403, code: "TotpEnrollmentRequired" });
  });

  it("only outside production, with requireTotp=false, lets an un-enrolled admin in on password alone", async () => {
    const { db } = await fakeDb({ totpSecretEnc: null });
    await expect(authenticateAdmin(db, "ops@example.com", PASSWORD, undefined, { requireTotp: false })).resolves.toBeTruthy();
  });

  it("still enforces the code for an enrolled admin even when requireTotp=false", async () => {
    const { db } = await fakeDb({ totpSecretEnc: enrolled() });
    expect(await failure(authenticateAdmin(db, "ops@example.com", PASSWORD, undefined, { requireTotp: false, now: () => NOW }))).toMatchObject({ code: "TotpRequired" });
  });

  it("treats a corrupt stored secret as a server fault, never as a bypass", async () => {
    const { db } = await fakeDb({ totpSecretEnc: "v1.garbage.garbage.garbage" });
    await expect(authenticateAdmin(db, "ops@example.com", PASSWORD, "123456", opts)).rejects.not.toBeInstanceOf(LoginFailure);
  });
});
