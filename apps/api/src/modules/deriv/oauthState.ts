import { timingSafeEqual } from "node:crypto";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";

// The PKCE verifier + CSRF state must survive the round trip to auth.deriv.com. Deriv's
// docs suggest sessionStorage in the browser, but the verifier is a secret the *backend*
// uses at token exchange — so it lives server-side-sealed instead: AES-GCM-encrypted into a
// short-lived cookie, bound to the app user who started the flow.
//
// Why a separate cookie, and why SameSite=Lax: the return trip from Deriv is a cross-site
// top-level navigation, and the app's session cookie is SameSite=Strict, so it is NOT sent
// on it. The user identity therefore travels inside this sealed cookie (set while the user
// was authenticated, at /connect) and is re-validated at callback.
//
// Two flows share this cookie: SIGN-IN (the user is anonymous; `userId` is null and the callback
// works out who they are from the Deriv accounts the token can see) and RECONNECT (a signed-in user
// refreshing their Deriv authorisation; `userId` is that user and the callback refuses to switch
// identity).

export const OAUTH_COOKIE_NAME = "derivdesk_oauth";
export const OAUTH_COOKIE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_COOKIE_PATH = "/api/deriv";

export interface OAuthFlowState {
  state: string;
  codeVerifier: string;
  /** null = sign-in flow (anonymous); a string = reconnect for that signed-in user. */
  userId: string | null;
  createdAt: number;
}

export function sealFlowState(flow: OAuthFlowState): string {
  return encryptSecret(JSON.stringify(flow));
}

export function unsealFlowState(sealed: string, now = Date.now()): OAuthFlowState | null {
  try {
    const flow = JSON.parse(decryptSecret(sealed)) as OAuthFlowState;
    if (
      typeof flow.state !== "string" ||
      typeof flow.codeVerifier !== "string" ||
      !(typeof flow.userId === "string" || flow.userId === null) ||
      typeof flow.createdAt !== "number"
    ) {
      return null;
    }
    if (now - flow.createdAt > OAUTH_COOKIE_TTL_MS || flow.createdAt > now + 5_000) {
      return null; // expired (or clock-skewed into the future)
    }
    return flow;
  } catch {
    return null; // tampered, wrong key, or not ours
  }
}

export function statesMatch(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Only these codes ever reach the browser URL — never Deriv's free-text error_description. */
export type ConnectFailureCode =
  | "access_denied"
  | "state_mismatch"
  | "expired"
  | "exchange_failed"
  | "accounts_failed"
  | "not_configured"
  | "no_accounts" // Deriv returned no tradable account for this authorisation
  | "account_conflict" // the accounts Deriv returned belong to more than one existing user here
  | "account_mismatch" // reconnect would have switched this session to a different Deriv user
  | "suspended"
  | "unknown";
