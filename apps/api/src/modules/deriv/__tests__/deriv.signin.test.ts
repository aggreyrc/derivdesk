import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@derivdesk/db";
import { completeCallback, flowKind, startConnection } from "../deriv.service.js";
import { sealFlowState, unsealFlowState } from "../oauthState.js";
import { DerivApiError, type DerivAccountRecord, type DerivClientLike } from "../deriv.client.js";

// Sign-in with Deriv is the only way to become a user. These tests run the real service against an
// in-memory database that enforces the same constraints as Postgres (unique Deriv account id,
// unique handle, all-or-nothing transactions), so conflicts and races are exercised for real.

type Row = Record<string, any>;

function memoryDb() {
  const state = { users: [] as Row[], accounts: [] as Row[], tokens: [] as Row[], seq: 0 };
  const uniq = (code = "P2002") => Object.assign(new Error("Unique constraint failed"), { code });
  const api: any = {
    user: {
      findUnique: async ({ where }: any) => state.users.find((u) => u.id === where.id) ?? null,
      create: async ({ data }: any) => {
        if (state.users.some((u) => u.handle === data.handle)) throw uniq();
        const row = { id: `user_${++state.seq}`, status: "ACTIVE", email: null, passwordHash: null, ...data };
        state.users.push(row);
        return row;
      },
    },
    derivAccount: {
      findMany: async ({ where }: any) => state.accounts.filter((a) => where.derivAccountId.in.includes(a.derivAccountId)),
      findFirst: async ({ where }: any) => state.accounts.find((a) => where.derivAccountId.in.includes(a.derivAccountId)) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const key = where.userId_derivAccountId;
        const existing = state.accounts.find((a) => a.userId === key.userId && a.derivAccountId === key.derivAccountId);
        if (existing) return Object.assign(existing, update);
        if (state.accounts.some((a) => a.derivAccountId === create.derivAccountId)) throw uniq(); // global unique
        const row = { id: `acc_${++state.seq}`, ...create };
        state.accounts.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        for (const a of state.accounts) if (a.userId === where.userId && !where.derivAccountId.notIn.includes(a.derivAccountId) && a.status !== "disconnected") Object.assign(a, data);
      },
    },
    derivOAuthToken: {
      upsert: async ({ where, create, update }: any) => {
        const existing = state.tokens.find((t) => t.userId === where.userId);
        if (existing) return Object.assign(existing, update);
        state.tokens.push({ ...create });
      },
    },
    // All-or-nothing: if the callback throws, every write inside it is undone.
    $transaction: async (fn: any) => {
      const snap = JSON.stringify({ u: state.users, a: state.accounts, t: state.tokens });
      try {
        return await fn(api);
      } catch (e) {
        const s = JSON.parse(snap);
        state.users = s.u; state.accounts = s.a; state.tokens = s.t;
        throw e;
      }
    },
  };
  return { db: api as PrismaClient, state };
}

const acct = (id: string, type: "demo" | "real" = "real"): DerivAccountRecord => ({ account_id: id, balance: 10, currency: "USD", group: type === "real" ? "real" : "virtual", status: "active", account_type: type });

function setup(accounts: DerivAccountRecord[] = [acct("CR100", "real"), acct("VRTC200", "demo")], clientOverrides: Partial<DerivClientLike> = {}) {
  const { db, state } = memoryDb();
  const client = {
    exchangeCode: vi.fn().mockResolvedValue({ access_token: "ory_at_secret", refresh_token: "ory_rt_secret", expires_in: 3600 }),
    listAccounts: vi.fn().mockResolvedValue(accounts),
    ...clientOverrides,
  } as unknown as DerivClientLike;
  const audit = vi.fn().mockResolvedValue(undefined);
  const deps = { db, client, audit, settings: { clientId: "app_1", scopes: "trade" } } as never;
  return { deps, db, state, client, audit };
}

const flow = (userId: string | null = null, state = "s1") => sealFlowState({ state, codeVerifier: "verifier", userId, createdAt: Date.now() });
const input = (sealed: string | undefined, over: Record<string, unknown> = {}) => ({ sealed, code: "auth_code", state: "s1", ip: "203.0.113.9", ...over });

describe("sign-up (first sign-in with Deriv)", () => {
  it("creates a user from the Deriv accounts: handle = the REAL account id, no email, no password", async () => {
    const { deps, state } = setup();
    const res = await completeCallback(deps, input(flow()));
    expect(res).toMatchObject({ kind: "signed_in", isNewUser: true, handle: "CR100" });
    expect(state.users).toHaveLength(1);
    expect(state.users[0]).toMatchObject({ handle: "CR100", email: null, passwordHash: null, status: "ACTIVE" });
  });

  it("falls back to the first account when there is only a demo account", async () => {
    const { deps } = setup([acct("VRTC9", "demo")]);
    expect(await completeCallback(deps, input(flow()))).toMatchObject({ handle: "VRTC9", isNewUser: true });
  });

  it("stores BOTH Deriv accounts, and the tokens only in encrypted form", async () => {
    const { deps, state } = setup();
    await completeCallback(deps, input(flow()));
    expect(state.accounts.map((a) => a.derivAccountId).sort()).toEqual(["CR100", "VRTC200"]);
    expect(state.accounts.every((a) => a.userId === state.users[0]!.id)).toBe(true);
    const t = state.tokens[0]!;
    expect(t.accessTokenEnc).not.toContain("ory_at_secret");
    expect(t.refreshTokenEnc).not.toContain("ory_rt_secret");
    expect(t.accessTokenEnc.startsWith("v1.")).toBe(true);
  });

  it("audits registration and login under the new handle, with no token or email in the metadata", async () => {
    const { deps, audit } = setup();
    await completeCallback(deps, input(flow()));
    const actions = audit.mock.calls.map((c) => c[0]);
    expect(actions.map((a) => a.action)).toEqual(["user.registered", "user.logged_in"]);
    for (const a of actions) {
      expect(a.actorEmail).toBe("CR100");
      expect(JSON.stringify(a)).not.toMatch(/ory_(at|rt)|@/);
    }
  });

  it("is all-or-nothing: if storing the accounts fails, no half-created user remains", async () => {
    const { deps, state, db } = setup();
    (db as any).derivAccount.upsert = async () => {
      throw new Error("disk full");
    };
    await expect(completeCallback(deps, input(flow()))).rejects.toThrow("disk full");
    expect(state.users).toHaveLength(0);
    expect(state.accounts).toHaveLength(0);
  });
});

describe("sign-in (returning user)", () => {
  it("matches the existing user by ANY returned Deriv account id — no duplicate user", async () => {
    const { deps, state } = setup();
    await completeCallback(deps, input(flow()));
    const again = await completeCallback(deps, input(flow()));
    expect(again).toMatchObject({ kind: "signed_in", isNewUser: false, handle: "CR100" });
    expect(state.users).toHaveLength(1);
  });

  it("recognises the user even if Deriv now lists only one of their accounts, or a brand-new one alongside", async () => {
    const { deps, state, client } = setup();
    await completeCallback(deps, input(flow()));
    (client.listAccounts as any).mockResolvedValue([acct("VRTC200", "demo"), acct("CR999", "real")]); // real CR100 gone, a new real account
    const res = await completeCallback(deps, input(flow()));
    expect(res).toMatchObject({ isNewUser: false, handle: "CR100" });
    expect(state.users).toHaveLength(1);
    expect(state.accounts.find((a) => a.derivAccountId === "CR999")!.userId).toBe(state.users[0]!.id); // picked up
    expect(state.accounts.find((a) => a.derivAccountId === "CR100")!.status).toBe("unavailable"); // marked, never deleted
  });

  it("refreshes the stored authorisation on every sign-in", async () => {
    const { deps, state, client } = setup();
    await completeCallback(deps, input(flow()));
    const first = state.tokens[0]!.accessTokenEnc;
    (client.exchangeCode as any).mockResolvedValue({ access_token: "ory_at_NEW", expires_in: 3600 });
    await completeCallback(deps, input(flow()));
    expect(state.tokens).toHaveLength(1);
    expect(state.tokens[0]!.accessTokenEnc).not.toBe(first);
    expect(state.tokens[0]!.needsReauth).toBe(false);
  });

  it("refuses a suspended user, and issues nothing", async () => {
    const { deps, state, audit } = setup();
    await completeCallback(deps, input(flow()));
    state.users[0]!.status = "SUSPENDED";
    audit.mockClear();
    await expect(completeCallback(deps, input(flow()))).rejects.toMatchObject({ code: "suspended" });
    expect(audit.mock.calls[0]![0].action).toBe("user.login_refused_suspended");
  });

  it("refuses to guess when the accounts belong to two different users here (never merges)", async () => {
    const { deps, state, client } = setup([acct("CR100")]);
    await completeCallback(deps, input(flow()));
    (client.listAccounts as any).mockResolvedValue([acct("CR200")]);
    await completeCallback(deps, input(flow())); // a second, unrelated user
    expect(state.users).toHaveLength(2);
    (client.listAccounts as any).mockResolvedValue([acct("CR100"), acct("CR200")]); // would link them
    await expect(completeCallback(deps, input(flow()))).rejects.toMatchObject({ code: "account_conflict" });
    expect(state.users).toHaveLength(2);
  });

  it("two simultaneous first sign-ins for the same Deriv user end up as ONE user", async () => {
    const { deps, state } = setup();
    const [a, b] = await Promise.all([completeCallback(deps, input(flow())), completeCallback(deps, input(flow()))]);
    expect(state.users).toHaveLength(1);
    expect(a.kind === "signed_in" && b.kind === "signed_in" && a.userId === b.userId).toBe(true);
  });
});

describe("reconnect (signed-in user refreshing their Deriv authorisation)", () => {
  it("keeps the same user and never creates one", async () => {
    const { deps, state } = setup();
    const first = await completeCallback(deps, input(flow()));
    const userId = first.kind === "signed_in" ? first.userId : "";
    const res = await completeCallback(deps, input(flow(userId)));
    expect(res).toEqual({ kind: "reconnected", userId });
    expect(state.users).toHaveLength(1);
  });

  it("refuses to switch this session to a DIFFERENT Deriv user (account_mismatch)", async () => {
    const { deps, state, client } = setup([acct("CR100")]);
    const a = await completeCallback(deps, input(flow()));
    (client.listAccounts as any).mockResolvedValue([acct("CR200")]);
    await completeCallback(deps, input(flow())); // user B exists with CR200
    const aId = a.kind === "signed_in" ? a.userId : "";
    // user A is signed in, but authorises Deriv as the owner of CR200:
    await expect(completeCallback(deps, input(flow(aId)))).rejects.toMatchObject({ code: "account_mismatch" });
    expect(state.accounts.filter((x) => x.userId === aId).map((x) => x.derivAccountId)).toEqual(["CR100"]); // CR200 was not moved
  });
});

describe("the OAuth handshake is still enforced", () => {
  it("rejects a state that does not match (login CSRF), before any code is spent", async () => {
    const { deps, client, state } = setup();
    await expect(completeCallback(deps, input(flow(null, "expected"), { state: "attacker" }))).rejects.toMatchObject({ code: "state_mismatch" });
    expect(client.exchangeCode).not.toHaveBeenCalled();
    expect(state.users).toHaveLength(0);
  });

  it("rejects a missing, expired or tampered flow cookie", async () => {
    const { deps } = setup();
    await expect(completeCallback(deps, input(undefined))).rejects.toMatchObject({ code: "expired" });
    const old = sealFlowState({ state: "s1", codeVerifier: "v", userId: null, createdAt: Date.now() - 11 * 60_000 });
    await expect(completeCallback(deps, input(old))).rejects.toMatchObject({ code: "expired" });
    await expect(completeCallback(deps, input(flow().slice(0, -3) + "xyz"))).rejects.toMatchObject({ code: "expired" });
  });

  it("maps a failed code exchange and an unreadable account list to safe codes, creating nothing", async () => {
    const a = setup(undefined, { exchangeCode: vi.fn().mockRejectedValue(new DerivApiError(400, "invalid_grant", "bad code ory_at_leak")) as never });
    await expect(completeCallback(a.deps, input(flow()))).rejects.toMatchObject({ code: "exchange_failed" });
    expect(a.state.users).toHaveLength(0);
    const b = setup(undefined, { listAccounts: vi.fn().mockRejectedValue(new Error("boom")) as never });
    await expect(completeCallback(b.deps, input(flow()))).rejects.toMatchObject({ code: "accounts_failed" });
    expect(b.state.users).toHaveLength(0);
  });

  it("refuses an authorisation that lists no Deriv account at all", async () => {
    const { deps, state } = setup([]);
    await expect(completeCallback(deps, input(flow()))).rejects.toMatchObject({ code: "no_accounts" });
    expect(state.users).toHaveLength(0);
  });
});

describe("flow plumbing", () => {
  it("startConnection(null) seals an anonymous sign-in flow; with a user id it seals a reconnect", () => {
    const client = { buildAuthorizationUrl: vi.fn().mockReturnValue("https://auth.deriv.com/x") } as never;
    const anon = startConnection({ client }, null);
    expect(unsealFlowState(anon.sealed)!.userId).toBeNull();
    const re = startConnection({ client }, "user_7");
    expect(unsealFlowState(re.sealed)!.userId).toBe("user_7");
  });

  it("flowKind tells sign-in from reconnect, and treats junk as sign-in (so errors land on the login page)", () => {
    expect(flowKind(flow(null), Date.now())).toBe("signin");
    expect(flowKind(flow("user_1"), Date.now())).toBe("reconnect");
    expect(flowKind("garbage", Date.now())).toBe("signin");
    expect(flowKind(undefined, Date.now())).toBe("signin");
  });
});
