import type { PrismaClient } from "@derivdesk/db";
import type { DerivAccountView, DerivConnectionState } from "@derivdesk/shared-types";
import { HttpError } from "../../middleware/errorHandler.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { generateCodeVerifier, generateState } from "../../lib/pkce.js";
import type { recordAudit } from "../../lib/audit.js";
import { DerivApiError, type DerivAccountRecord, type DerivClientLike } from "./deriv.client.js";
import { logger } from "../../lib/logger.js";
import { sealFlowState, statesMatch, unsealFlowState, type ConnectFailureCode } from "./oauthState.js";

export interface DerivDeps {
  db: PrismaClient;
  client: DerivClientLike;
  audit: typeof recordAudit;
  settings: { clientId: string; scopes: string };
  now?: () => Date;
}

export interface Actor {
  userId: string;
  label: string;
  ip?: string;
}

/** Thrown for OAuth callback failures; `code` is safe to show in a redirect URL. */
export class ConnectError extends Error {
  constructor(public code: ConnectFailureCode) {
    super(code);
  }
}

const ACCESS_TOKEN_SKEW_MS = 60_000; // refresh a minute early
const FALLBACK_TOKEN_LIFETIME_MS = 15 * 60_000; // only if Deriv gives neither expires_in nor a JWT exp

// ---------------------------------------------------------------------------
// Connect flow
// ---------------------------------------------------------------------------

/** `userId` = reconnect for that signed-in user; `null` = sign-in / sign-up (anonymous). */
export function startConnection(deps: Pick<DerivDeps, "client" | "now">, userId: string | null) {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const url = deps.client.buildAuthorizationUrl({ state, codeVerifier });
  const sealed = sealFlowState({ state, codeVerifier, userId, createdAt: (deps.now?.() ?? new Date()).getTime() });
  return { url, sealed };
}

export type CallbackResult =
  | { kind: "reconnected"; userId: string }
  | { kind: "signed_in"; userId: string; handle: string; isNewUser: boolean };

/** Which screen to send the browser back to when the callback fails: needs no secrets, only the flow's shape. */
export function flowKind(sealed: string | undefined, now: number): "signin" | "reconnect" {
  const flow = sealed ? unsealFlowState(sealed, now) : null;
  return flow?.userId ? "reconnect" : "signin";
}

/**
 * Finishes the Deriv OAuth flow for BOTH cases.
 *
 * Identity model (Deriv-only sign-up): Deriv documents no user id, email or user-info endpoint, so a
 * user here IS the set of Deriv account ids that the authorising token can see (the same `account_id`
 * values Deriv's own API uses). Those ids are unique to one Deriv user, and only that user can
 * authorise a token that lists them, so matching on them is as strong as Deriv's own OAuth. If any
 * returned account already belongs to an app user, that user signs in; if none do, a new user is
 * created. We never merge users and never move a Deriv account between users.
 */
export async function completeCallback(
  deps: DerivDeps,
  input: { sealed: string | undefined; code: unknown; state: unknown; ip?: string },
): Promise<CallbackResult> {
  const flow = input.sealed ? unsealFlowState(input.sealed, (deps.now?.() ?? new Date()).getTime()) : null;
  if (!flow) throw new ConnectError("expired");
  if (!statesMatch(flow.state, input.state)) throw new ConnectError("state_mismatch");
  if (typeof input.code !== "string" || input.code === "") throw new ConnectError("unknown");

  // Reconnect: the user must still exist and be active before we spend a code on them.
  let reconnectUser: { id: string; handle: string } | null = null;
  if (flow.userId) {
    const u = await deps.db.user.findUnique({ where: { id: flow.userId } });
    if (!u || u.status !== "ACTIVE") throw new ConnectError("unknown");
    reconnectUser = { id: u.id, handle: u.handle };
  }

  let tokens;
  try {
    tokens = await deps.client.exchangeCode({ code: input.code, codeVerifier: flow.codeVerifier });
  } catch (err) {
    if (reconnectUser) {
      await deps.audit({ actorId: reconnectUser.id, actorEmail: reconnectUser.handle, action: "deriv.connect_failed", targetType: "deriv_connection", metadata: { reason: err instanceof DerivApiError ? err.code : "unknown" }, ip: input.ip });
    } else {
      // Anonymous: there is no user to attribute it to, so it is logged (no PII) rather than audited.
      logger.warn({ event: "auth.deriv_exchange_failed", reason: err instanceof DerivApiError ? err.code : "unknown", ip: input.ip }, "Deriv sign-in failed at code exchange");
    }
    throw new ConnectError("exchange_failed");
  }

  let accounts: DerivAccountRecord[];
  try {
    accounts = await deps.client.listAccounts(tokens.access_token);
  } catch {
    throw new ConnectError("accounts_failed");
  }
  if (accounts.length === 0) throw new ConnectError("no_accounts");
  const accountIds = accounts.map((a) => a.account_id);

  // Who already owns any of these Deriv accounts?
  const owned = await deps.db.derivAccount.findMany({ where: { derivAccountId: { in: accountIds } }, select: { userId: true } });
  const owners = [...new Set(owned.map((o) => o.userId))];

  const now = deps.now?.() ?? new Date();
  const tokenData = {
    authType: "OAUTH" as const,
    accessTokenEnc: encryptSecret(tokens.access_token),
    refreshTokenEnc: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null,
    scopes: tokens.scope ?? deps.settings.scopes,
    expiresAt: computeExpiry(tokens.expires_in, tokens.access_token, now),
    derivClientId: deps.settings.clientId,
    needsReauth: false,
  };

  // ---- reconnect: same user only --------------------------------------------------------------
  if (reconnectUser) {
    if (owners.some((id) => id !== reconnectUser.id)) throw new ConnectError("account_mismatch");
    await storeConnection(deps.db, reconnectUser.id, tokenData, accounts, now);
    await deps.audit({ actorId: reconnectUser.id, actorEmail: reconnectUser.handle, action: "deriv.connected", targetType: "deriv_connection", metadata: { scopes: tokenData.scopes }, ip: input.ip });
    return { kind: "reconnected", userId: reconnectUser.id };
  }

  // ---- sign-in / sign-up -----------------------------------------------------------------------
  if (owners.length > 1) {
    logger.warn({ event: "auth.deriv_account_conflict", owners: owners.length, ip: input.ip }, "Deriv sign-in refused: the accounts belong to several app users");
    throw new ConnectError("account_conflict");
  }

  let isNewUser = false;
  let user: { id: string; handle: string; status: string };
  if (owners.length === 1) {
    const existing = await deps.db.user.findUnique({ where: { id: owners[0]! } });
    if (!existing) throw new ConnectError("unknown");
    user = existing;
  } else {
    // First sign-in with Deriv: create the user, its authorisation and its accounts atomically, so a
    // failure never leaves a user with no way in (or accounts with no owner).
    const handle = (accounts.find((a) => a.account_type === "real") ?? accounts[0]!).account_id;
    try {
      user = await deps.db.$transaction(async (tx) => {
        const created = await tx.user.create({ data: { handle } });
        await storeConnection(tx as unknown as PrismaClient, created.id, tokenData, accounts, now);
        return created;
      });
      isNewUser = true;
    } catch (err) {
      // Two first sign-ins racing: the loser hits the unique constraint on the Deriv account id (or
      // handle). The winner's rows exist now, so resolve normally instead of failing the user.
      if (!isUniqueViolation(err)) throw err;
      const raced = await deps.db.derivAccount.findFirst({ where: { derivAccountId: { in: accountIds } }, select: { userId: true } });
      const found = raced ? await deps.db.user.findUnique({ where: { id: raced.userId } }) : null;
      if (!found) throw err;
      user = found;
    }
  }

  if (user.status !== "ACTIVE") {
    await deps.audit({ actorId: user.id, actorEmail: user.handle, action: "user.login_refused_suspended", targetType: "user", targetId: user.id, ip: input.ip });
    throw new ConnectError("suspended");
  }
  if (!isNewUser) await storeConnection(deps.db, user.id, tokenData, accounts, now);

  if (isNewUser) {
    await deps.audit({ actorId: user.id, actorEmail: user.handle, action: "user.registered", targetType: "user", targetId: user.id, metadata: { via: "deriv", accounts: accounts.length }, ip: input.ip });
  }
  await deps.audit({ actorId: user.id, actorEmail: user.handle, action: "user.logged_in", targetType: "user", targetId: user.id, metadata: { via: "deriv" }, ip: input.ip });
  return { kind: "signed_in", userId: user.id, handle: user.handle, isNewUser };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/** Saves the (encrypted) Deriv authorisation and reconciles the account list for one user. */
async function storeConnection(
  db: PrismaClient,
  userId: string,
  tokenData: {
    authType: "OAUTH";
    accessTokenEnc: string;
    refreshTokenEnc: string | null;
    scopes: string;
    expiresAt: Date;
    derivClientId: string;
    needsReauth: boolean;
  },
  accounts: DerivAccountRecord[],
  now: Date,
) {
  await db.derivOAuthToken.upsert({ where: { userId }, create: { userId, ...tokenData }, update: tokenData });
  await applyAccounts(db, userId, accounts, now);
}

function computeExpiry(expiresIn: number | undefined, accessToken: string, now: Date): Date {
  if (expiresIn) return new Date(now.getTime() + expiresIn * 1000);
  // Deriv's docs say the token may be a JWT; if so its own `exp` claim is authoritative.
  const exp = readJwtExp(accessToken);
  if (exp) return new Date(exp * 1000);
  return new Date(now.getTime() + FALLBACK_TOKEN_LIFETIME_MS);
}

function readJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

const inflightRefreshes = new Map<string, Promise<string>>();

/**
 * Returns a usable Deriv access token for this app user, refreshing it if it is (nearly)
 * expired. Concurrent callers for the same user share ONE refresh — with rotating refresh
 * tokens, two parallel refreshes would invalidate each other. (In-process only: if you run
 * multiple api instances, add a DB advisory lock before scaling out.)
 */
export async function getValidAccessToken(deps: DerivDeps, userId: string): Promise<string> {
  const row = await deps.db.derivOAuthToken.findUnique({ where: { userId } });
  if (!row) throw new HttpError(409, "NotConnected", "No Deriv account is connected");
  if (row.needsReauth) throw new HttpError(409, "ReauthRequired", "Your Deriv connection has expired — please reconnect");

  const now = deps.now?.() ?? new Date();
  if (row.expiresAt.getTime() - ACCESS_TOKEN_SKEW_MS > now.getTime()) {
    return decryptSecret(row.accessTokenEnc);
  }

  const existing = inflightRefreshes.get(userId);
  if (existing) return existing;

  const refresh = (async () => {
    try {
      if (!row.refreshTokenEnc) throw new DerivApiError(400, "NoRefreshToken", "No refresh token stored");
      const tokens = await deps.client.refresh(decryptSecret(row.refreshTokenEnc));
      await deps.db.derivOAuthToken.update({
        where: { userId },
        data: {
          accessTokenEnc: encryptSecret(tokens.access_token),
          // Keep the old refresh token unless Deriv rotated it.
          ...(tokens.refresh_token ? { refreshTokenEnc: encryptSecret(tokens.refresh_token) } : {}),
          expiresAt: computeExpiry(tokens.expires_in, tokens.access_token, deps.now?.() ?? new Date()),
        },
      });
      return tokens.access_token;
    } catch (err) {
      const definitive = !(err instanceof DerivApiError) || err.status < 500; // outage (5xx/timeout) ≠ revoked
      if (definitive) {
        await deps.db.derivOAuthToken.update({ where: { userId }, data: { needsReauth: true } });
        await deps.audit({ actorId: userId, actorEmail: "system", action: "deriv.token_refresh_failed", targetType: "deriv_connection", metadata: { reason: err instanceof DerivApiError ? err.code : "unknown" } });
        throw new HttpError(409, "ReauthRequired", "Your Deriv connection has expired — please reconnect");
      }
      throw new HttpError(503, "DerivUnavailable", "Deriv is temporarily unreachable");
    } finally {
      inflightRefreshes.delete(userId);
    }
  })();
  inflightRefreshes.set(userId, refresh);
  return refresh;
}

// ---------------------------------------------------------------------------
// Accounts (Deriv is the source of truth; our rows are a reconciled cache)
// ---------------------------------------------------------------------------

export async function syncAccounts(deps: DerivDeps, userId: string, accessToken: string): Promise<number> {
  const accounts = await deps.client.listAccounts(accessToken);
  await applyAccounts(deps.db, userId, accounts, deps.now?.() ?? new Date());
  return accounts.length;
}

async function applyAccounts(db: PrismaClient, userId: string, accounts: DerivAccountRecord[], now: Date): Promise<void> {
  for (const a of accounts) {
    const fields = {
      accountType: a.account_type === "demo" ? ("DEMO" as const) : ("REAL" as const),
      currency: a.currency,
      group: a.group,
      status: a.status,
      cachedBalance: String(a.balance),
      cachedBalanceAt: now,
    };
    await db.derivAccount.upsert({
      where: { userId_derivAccountId: { userId, derivAccountId: a.account_id } },
      create: { userId, derivAccountId: a.account_id, ...fields },
      update: fields,
    });
  }

  // Accounts Deriv no longer returns are marked, not deleted: they may carry trade history we still
  // want for analytics, and Deriv's list — not our cache — decides whether they can be traded on.
  await db.derivAccount.updateMany({
    where: { userId, derivAccountId: { notIn: accounts.map((a) => a.account_id) }, status: { not: "disconnected" } },
    data: { status: "unavailable" },
  });
}

export async function refreshAccounts(deps: DerivDeps, userId: string): Promise<number> {
  const token = await getValidAccessToken(deps, userId);
  try {
    return await syncAccounts(deps, userId, token);
  } catch (err) {
    if (err instanceof DerivApiError && err.status === 401) {
      await deps.db.derivOAuthToken.update({ where: { userId }, data: { needsReauth: true } });
      throw new HttpError(409, "ReauthRequired", "Your Deriv connection has expired — please reconnect");
    }
    throw new HttpError(502, "DerivError", "Could not refresh accounts from Deriv");
  }
}

export async function getConnectionState(deps: Pick<DerivDeps, "db">, userId: string, sessionId: string): Promise<DerivConnectionState> {
  const [token, rows, session] = await Promise.all([
    deps.db.derivOAuthToken.findUnique({ where: { userId } }),
    deps.db.derivAccount.findMany({ where: { userId }, orderBy: [{ accountType: "asc" }, { derivAccountId: "asc" }] }),
    deps.db.session.findFirst({ where: { id: sessionId, userId } }),
  ]);

  const usable = rows.filter((r) => r.status === "active");
  let activeId = session?.activeDerivAccountId ?? null;
  if (activeId && !usable.some((r) => r.id === activeId)) activeId = null; // it went away or was deactivated

  // Default selection is ALWAYS a demo account — a real account is only ever active because the user
  // explicitly asked (see activateAccount). No demo account → nothing active, never "fall through to real".
  if (!activeId && session) {
    const demo = usable.find((r) => r.accountType === "DEMO");
    if (demo) {
      await deps.db.session.update({ where: { id: session.id }, data: { activeDerivAccountId: demo.id } });
      activeId = demo.id;
    } else if (session.activeDerivAccountId) {
      await deps.db.session.update({ where: { id: session.id }, data: { activeDerivAccountId: null } });
    }
  }

  const accounts: DerivAccountView[] = rows.map((r) => ({
    id: r.id,
    derivAccountId: r.derivAccountId,
    accountType: r.accountType,
    currency: r.currency,
    group: r.group,
    status: r.status,
    nickname: r.nickname,
    cachedBalance: r.cachedBalance?.toString() ?? null,
    cachedBalanceAt: r.cachedBalanceAt?.toISOString() ?? null,
    isActive: r.id === activeId,
  }));

  // After a disconnect the cached rows remain (history), but they aren't usable, so don't present them.
  return { connected: !!token && !token.needsReauth, needsReauth: !!token?.needsReauth, accounts: token ? accounts : [], activeAccountId: token ? activeId : null };
}

export async function activateAccount(deps: Pick<DerivDeps, "db" | "audit">, actor: Actor, input: { sessionId: string; accountId: string; confirmReal: boolean }) {
  // Scoped by userId: an id belonging to someone else is indistinguishable from one that doesn't exist.
  const account = await deps.db.derivAccount.findFirst({ where: { id: input.accountId, userId: actor.userId } });
  if (!account) throw new HttpError(404, "NotFound", "Account not found");
  if (account.status !== "active") throw new HttpError(409, "AccountUnavailable", "This account is not currently available on Deriv");

  if (account.accountType === "REAL" && !input.confirmReal) {
    throw new HttpError(409, "RealAccountConfirmationRequired", "Switching to a real-money account requires explicit confirmation");
  }

  const updated = await deps.db.session.updateMany({ where: { id: input.sessionId, userId: actor.userId }, data: { activeDerivAccountId: account.id } });
  if (updated.count !== 1) throw new HttpError(401, "Unauthorized", "Session not found");

  await deps.audit({
    actorId: actor.userId,
    actorEmail: actor.label,
    action: "deriv.account_activated",
    targetType: "deriv_account",
    targetId: account.id,
    metadata: { accountType: account.accountType, derivAccountId: account.derivAccountId },
    ip: actor.ip,
  });
}

export async function disconnect(deps: Pick<DerivDeps, "db" | "audit">, actor: Actor) {
  await deps.db.derivOAuthToken.deleteMany({ where: { userId: actor.userId } });
  await deps.db.derivAccount.updateMany({ where: { userId: actor.userId }, data: { status: "disconnected" } });
  await deps.db.session.updateMany({ where: { userId: actor.userId }, data: { activeDerivAccountId: null } });
  await deps.audit({ actorId: actor.userId, actorEmail: actor.label, action: "deriv.disconnected", targetType: "deriv_connection", ip: actor.ip });
}
