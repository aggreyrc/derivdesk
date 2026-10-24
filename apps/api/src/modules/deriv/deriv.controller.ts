import type { CookieOptions, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { config, getDerivSettings } from "../../lib/config.js";
import { logger } from "../../lib/logger.js";
import { recordAudit } from "../../lib/audit.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { createSession, setSessionCookie } from "../../lib/session.js";
import { DerivClient } from "./deriv.client.js";
import { OAUTH_COOKIE_NAME, OAUTH_COOKIE_PATH, OAUTH_COOKIE_TTL_MS, type ConnectFailureCode } from "./oauthState.js";
import {
  ConnectError,
  activateAccount,
  completeCallback,
  flowKind,
  disconnect,
  getConnectionState,
  refreshAccounts,
  startConnection,
  type Actor,
  type DerivDeps,
} from "./deriv.service.js";

function getDeps(): DerivDeps {
  const settings = getDerivSettings();
  if (!settings) {
    throw new HttpError(503, "DerivNotConfigured", "Deriv integration is not configured on this server");
  }
  return { db: prisma, client: new DerivClient(settings), audit: recordAudit, settings };
}

function actorOf(req: Request): Actor {
  // requireAuth guarantees these; they come from the verified session, never from the request body.
  return { userId: req.userId!, label: req.userLabel!, ip: req.ip };
}

const oauthCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: config.NODE_ENV === "production",
  sameSite: "lax", // must survive the cross-site redirect back from auth.deriv.com (see oauthState.ts)
  path: OAUTH_COOKIE_PATH,
  maxAge: OAUTH_COOKIE_TTL_MS,
};

// GET /api/deriv/login — the ONLY way to sign up or sign in (there are no passwords). A plain
// top-level navigation from the login page: seals the PKCE/state cookie and 302s to Deriv.
export async function startSignIn(_req: Request, res: Response) {
  let deps: DerivDeps;
  try {
    deps = getDeps();
  } catch {
    return redirectToApp(res, "signin", { error: "not_configured" });
  }
  const { url, sealed } = startConnection(deps, null);
  res.cookie(OAUTH_COOKIE_NAME, sealed, oauthCookieOptions);
  res.redirect(302, url);
}

// GET /api/deriv/connect — called by the SPA via fetch (credentials included) while signed in, to
// RECONNECT (e.g. after the Deriv authorisation expired). Returns the Deriv authorization URL.
export async function connect(req: Request, res: Response) {
  const deps = getDeps();
  const { url, sealed } = startConnection(deps, req.userId!);
  res.cookie(OAUTH_COOKIE_NAME, sealed, oauthCookieOptions);
  res.json({ data: { url } });
}

type Outcome = { connected: true } | { signedIn: true; isNewUser: boolean } | { error: ConnectFailureCode };

// Sign-in problems go back to the login page (the user has no session to look at an account page
// with); reconnect problems go back to the account page.
function redirectToApp(res: Response, kind: "signin" | "reconnect", outcome: Outcome) {
  const target = new URL(kind === "signin" ? ("error" in outcome ? "/login" : "/") : "/account", config.WEB_APP_URL);
  if ("connected" in outcome) target.searchParams.set("deriv", "connected");
  else if ("signedIn" in outcome) target.searchParams.set("welcome", outcome.isNewUser ? "new" : "back");
  else target.searchParams.set("deriv_error", outcome.error);
  res.redirect(303, target.toString());
}

// GET /api/deriv/callback — top-level navigation from auth.deriv.com. No session cookie is sent
// here (SameSite=Strict), so what we know about the flow comes from the sealed OAuth cookie that THIS
// browser received when it started the flow (an attacker cannot plant one), plus the PKCE verifier.
export async function callback(req: Request, res: Response) {
  const sealed = req.cookies?.[OAUTH_COOKIE_NAME] as string | undefined;
  res.clearCookie(OAUTH_COOKIE_NAME, { path: OAUTH_COOKIE_PATH }); // single use, whatever happens next
  const kind = flowKind(sealed, Date.now());

  // The user declined (or Deriv reported an error). Never echo Deriv's free-text error_description.
  if (typeof req.query.error === "string") {
    return redirectToApp(res, kind, { error: req.query.error === "access_denied" ? "access_denied" : "unknown" });
  }

  let deps: DerivDeps;
  try {
    deps = getDeps();
  } catch {
    return redirectToApp(res, kind, { error: "not_configured" });
  }

  try {
    const result = await completeCallback(deps, { sealed, code: req.query.code, state: req.query.state, ip: req.ip });
    if (result.kind === "reconnected") return redirectToApp(res, "reconnect", { connected: true });

    // Signed in with Deriv: this is the moment a session exists. A fresh session never starts on a
    // real account (getConnectionState defaults to a demo account only).
    const session = await createSession(result.userId, req.ip, req.get("user-agent") ?? undefined);
    setSessionCookie(res, session.id);
    await prisma.user.update({ where: { id: result.userId }, data: { lastLoginAt: new Date() } });
    return redirectToApp(res, "signin", { signedIn: true, isNewUser: result.isNewUser });
  } catch (err) {
    if (err instanceof ConnectError) return redirectToApp(res, kind, { error: err.code });
    logger.error({ err }, "unexpected error completing Deriv callback");
    return redirectToApp(res, kind, { error: "unknown" });
  }
}

// GET /api/deriv/accounts — our reconciled view of the user's Deriv accounts + which is active.
export async function accounts(req: Request, res: Response) {
  const state = await getConnectionState({ db: prisma }, req.userId!, req.sessionId!);
  res.json({ data: state });
}

// POST /api/deriv/accounts/refresh — re-pull the account list from Deriv (source of truth).
export async function refresh(req: Request, res: Response) {
  const deps = getDeps();
  await refreshAccounts(deps, req.userId!);
  const state = await getConnectionState(deps, req.userId!, req.sessionId!);
  res.json({ data: state });
}

const activateSchema = z.object({ confirmReal: z.boolean().optional() }).strict();

// POST /api/deriv/accounts/:id/activate — switch the session's active account.
export async function activate(req: Request, res: Response) {
  const parsed = activateSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new HttpError(400, "ValidationError", "Invalid request body");
  const accountId = req.params.id;
  if (!accountId) throw new HttpError(400, "ValidationError", "Account id is required");

  const deps = { db: prisma, audit: recordAudit }; // activation never calls Deriv
  await activateAccount(deps, actorOf(req), { sessionId: req.sessionId!, accountId, confirmReal: parsed.data.confirmReal === true });
  const state = await getConnectionState(deps, req.userId!, req.sessionId!);
  res.json({ data: state });
}

// DELETE /api/deriv/connection — forget the connection on our side.
export async function disconnectConnection(req: Request, res: Response) {
  const deps = { db: prisma, audit: recordAudit };
  await disconnect(deps, actorOf(req));
  res.status(204).send();
}
