import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@derivdesk/db";
import {
  activateAccount,
  completeCallback,
  disconnect,
  getConnectionState,
  getValidAccessToken,
  syncAccounts,
  ConnectError,
} from "./deriv.service.js";
import { sealFlowState } from "./oauthState.js";
import { DerivApiError, type DerivClientLike } from "./deriv.client.js";

function fakeAudit() {
  return vi.fn().mockResolvedValue(undefined);
}

function fakeDb(overrides: Record<string, Record<string, unknown>> = {}) {
  return {
    user: { findUnique: vi.fn(), ...overrides.user },
    derivOAuthToken: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn(), deleteMany: vi.fn(), ...overrides.derivOAuthToken },
    derivAccount: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), ...overrides.derivAccount },
    session: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), ...overrides.session },
  } as unknown as PrismaClient;
}

const settings = { clientId: "app_1", scopes: "trade" };

describe("getConnectionState", () => {
  it("auto-selects a demo account but NEVER a real one", async () => {
    const session = { id: "sess_1", userId: "user_1", activeDerivAccountId: null };
    const db = fakeDb({
      derivOAuthToken: { findUnique: vi.fn().mockResolvedValue({ needsReauth: false }) },
      derivAccount: {
        findMany: vi.fn().mockResolvedValue([
          { id: "acc_real", userId: "user_1", derivAccountId: "CR1", accountType: "REAL", currency: "USD", group: "real", status: "active", nickname: null, cachedBalance: null, cachedBalanceAt: null },
          { id: "acc_demo", userId: "user_1", derivAccountId: "VRTC1", accountType: "DEMO", currency: "USD", group: "virtual", status: "active", nickname: null, cachedBalance: null, cachedBalanceAt: null },
        ]),
      },
      session: { findFirst: vi.fn().mockResolvedValue(session), update: vi.fn().mockResolvedValue(session) },
    });

    const state = await getConnectionState({ db }, "user_1", "sess_1");

    expect(state.activeAccountId).toBe("acc_demo");
    expect(state.accounts.find((a) => a.id === "acc_real")!.isActive).toBe(false);
  });

  it("activates nothing when only a real account exists — no silent fallback to real", async () => {
    const db = fakeDb({
      derivOAuthToken: { findUnique: vi.fn().mockResolvedValue({ needsReauth: false }) },
      derivAccount: {
        findMany: vi.fn().mockResolvedValue([
          { id: "acc_real", userId: "user_1", derivAccountId: "CR1", accountType: "REAL", currency: "USD", group: "real", status: "active", nickname: null, cachedBalance: null, cachedBalanceAt: null },
        ]),
      },
      session: { findFirst: vi.fn().mockResolvedValue({ id: "sess_1", userId: "user_1", activeDerivAccountId: null }) },
    });

    const state = await getConnectionState({ db }, "user_1", "sess_1");

    expect(state.activeAccountId).toBeNull();
    expect(db.session.update).not.toHaveBeenCalled();
  });

  it("hides accounts once the Deriv connection is gone", async () => {
    const db = fakeDb({
      derivOAuthToken: { findUnique: vi.fn().mockResolvedValue(null) },
      derivAccount: { findMany: vi.fn().mockResolvedValue([{ id: "acc_1" }]) },
      session: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    const state = await getConnectionState({ db }, "user_1", "sess_1");
    expect(state).toMatchObject({ connected: false, accounts: [], activeAccountId: null });
  });
});

describe("activateAccount", () => {
  it("refuses to activate an account belonging to another user (IDOR)", async () => {
    const db = fakeDb({ derivAccount: { findFirst: vi.fn().mockResolvedValue(null) } }); // scoped query found nothing
    await expect(
      activateAccount({ db, audit: fakeAudit() }, { userId: "user_1", label: "CR1000001" }, { sessionId: "sess_1", accountId: "acc_of_someone_else", confirmReal: false }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("requires explicit confirmation before activating a real account", async () => {
    const db = fakeDb({ derivAccount: { findFirst: vi.fn().mockResolvedValue({ id: "acc_1", userId: "user_1", accountType: "REAL", status: "active" }) } });
    await expect(
      activateAccount({ db, audit: fakeAudit() }, { userId: "user_1", label: "CR1000001" }, { sessionId: "sess_1", accountId: "acc_1", confirmReal: false }),
    ).rejects.toMatchObject({ status: 409, code: "RealAccountConfirmationRequired" });
    expect(db.session.updateMany).not.toHaveBeenCalled();
  });

  it("activates a real account once confirmed, and audits it", async () => {
    const audit = fakeAudit();
    const db = fakeDb({
      derivAccount: { findFirst: vi.fn().mockResolvedValue({ id: "acc_1", userId: "user_1", accountType: "REAL", status: "active", derivAccountId: "CR1" }) },
      session: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    });

    await activateAccount({ db, audit }, { userId: "user_1", label: "CR1000001" }, { sessionId: "sess_1", accountId: "acc_1", confirmReal: true });

    expect(db.session.updateMany).toHaveBeenCalledWith({ where: { id: "sess_1", userId: "user_1" }, data: { activeDerivAccountId: "acc_1" } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "deriv.account_activated" }));
  });

  it("refuses to activate an account Deriv no longer reports as active", async () => {
    const db = fakeDb({ derivAccount: { findFirst: vi.fn().mockResolvedValue({ id: "acc_1", userId: "user_1", accountType: "DEMO", status: "unavailable" }) } });
    await expect(
      activateAccount({ db, audit: fakeAudit() }, { userId: "user_1", label: "CR1000001" }, { sessionId: "sess_1", accountId: "acc_1", confirmReal: false }),
    ).rejects.toMatchObject({ status: 409, code: "AccountUnavailable" });
  });
});

describe("completeCallback", () => {
  it("rejects a state that doesn't match (CSRF protection)", async () => {
    const client = { exchangeCode: vi.fn() };
    const deps = { db: fakeDb(), client, audit: fakeAudit(), settings } as never;
    const sealed = sealFlowState({ state: "expected", codeVerifier: "v", userId: "user_1", createdAt: Date.now() });

    await expect(completeCallback(deps, { sealed, code: "auth_code", state: "attacker_supplied", ip: undefined })).rejects.toBeInstanceOf(ConnectError);
    expect(client.exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects a missing/expired flow cookie", async () => {
    const deps = { db: fakeDb(), client: { exchangeCode: vi.fn() }, audit: fakeAudit(), settings } as never;
    await expect(completeCallback(deps, { sealed: undefined, code: "auth_code", state: "s", ip: undefined })).rejects.toMatchObject({ code: "expired" });
  });
});

describe("getValidAccessToken", () => {
  it("marks the connection for re-auth when a refresh definitively fails (4xx)", async () => {
    const client = { refresh: vi.fn().mockRejectedValue(new DerivApiError(400, "invalid_grant", "revoked")) } as unknown as DerivClientLike;
    const db = fakeDb({
      derivOAuthToken: {
        findUnique: vi.fn().mockResolvedValue({ needsReauth: false, expiresAt: new Date(Date.now() - 1000), refreshTokenEnc: "irrelevant-for-mock" }),
        update: vi.fn().mockResolvedValue({}),
      },
    });
    vi.spyOn(await import("../../lib/crypto.js"), "decryptSecret").mockReturnValue("refresh-token");

    await expect(getValidAccessToken({ db, client, audit: fakeAudit(), settings }, "user_1")).rejects.toMatchObject({ status: 409, code: "ReauthRequired" });
    expect(db.derivOAuthToken.update).toHaveBeenCalledWith({ where: { userId: "user_1" }, data: { needsReauth: true } });
  });

  it("does not require re-auth on a transient Deriv outage (5xx)", async () => {
    const client = { refresh: vi.fn().mockRejectedValue(new DerivApiError(503, "unavailable", "down")) } as unknown as DerivClientLike;
    const db = fakeDb({
      derivOAuthToken: {
        findUnique: vi.fn().mockResolvedValue({ needsReauth: false, expiresAt: new Date(Date.now() - 1000), refreshTokenEnc: "irrelevant-for-mock" }),
        update: vi.fn().mockResolvedValue({}),
      },
    });
    vi.spyOn(await import("../../lib/crypto.js"), "decryptSecret").mockReturnValue("refresh-token");

    await expect(getValidAccessToken({ db, client, audit: fakeAudit(), settings }, "user_1")).rejects.toMatchObject({ status: 503 });
    expect(db.derivOAuthToken.update).not.toHaveBeenCalled();
  });
});

describe("syncAccounts", () => {
  it("marks accounts Deriv stopped reporting as unavailable rather than deleting them", async () => {
    const client = { listAccounts: vi.fn().mockResolvedValue([{ account_id: "CR1", balance: 100, currency: "USD", group: "real", status: "active", account_type: "real" }]) } as unknown as DerivClientLike;
    const db = fakeDb();

    await syncAccounts({ db, client, audit: fakeAudit(), settings }, "user_1", "token");

    expect(db.derivAccount.upsert).toHaveBeenCalledTimes(1);
    expect(db.derivAccount.updateMany).toHaveBeenCalledWith({
      where: { userId: "user_1", derivAccountId: { notIn: ["CR1"] }, status: { not: "disconnected" } },
      data: { status: "unavailable" },
    });
  });
});

describe("disconnect", () => {
  it("clears the token, deactivates cached accounts, and clears any active session pointer", async () => {
    const audit = fakeAudit();
    const db = fakeDb();

    await disconnect({ db, audit }, { userId: "user_1", label: "CR1000001" });

    expect(db.derivOAuthToken.deleteMany).toHaveBeenCalledWith({ where: { userId: "user_1" } });
    expect(db.derivAccount.updateMany).toHaveBeenCalledWith({ where: { userId: "user_1" }, data: { status: "disconnected" } });
    expect(db.session.updateMany).toHaveBeenCalledWith({ where: { userId: "user_1" }, data: { activeDerivAccountId: null } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "deriv.disconnected" }));
  });
});
