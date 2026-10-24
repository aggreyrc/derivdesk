import { API_BASE_URL } from "./apiBase";

// Deriv is the only way in: there is no sign-up form and no password. "Continue with Deriv" is a
// plain top-level navigation to the API, which redirects the browser to Deriv's own sign-in page.
export function signInUrl(apiBase: string = API_BASE_URL): string {
  return `${apiBase.replace(/\/+$/, "")}/api/deriv/login`;
}

/** Plain-language text for the failure codes the API puts in `?deriv_error=`. Anything unknown gets
 *  the generic message — the URL is attacker-controllable, so it is only ever used as a lookup key. */
const MESSAGES: Record<string, string> = {
  access_denied: "You declined the request on Deriv, so you weren't signed in.",
  state_mismatch: "That attempt couldn't be verified — please try again.",
  expired: "That attempt took too long or was interrupted — please try again.",
  exchange_failed: "Deriv didn't accept the request — please try again.",
  accounts_failed: "Deriv accepted you, but we couldn't read your account list. Please try again in a moment.",
  no_accounts: "Deriv didn't return a trading account for this login. Create or enable a Deriv trading account, then try again.",
  account_conflict: "Those Deriv accounts are linked to more than one DerivDesk profile, so we can't sign you in automatically. Please contact support.",
  account_mismatch: "You authorised a different Deriv user than the one signed in here. Sign out, then sign in with that Deriv account.",
  suspended: "This DerivDesk account has been suspended.",
  not_configured: "Deriv sign-in isn't configured on this server yet.",
  unknown: "Something went wrong signing in with Deriv. Please try again.",
};

export function deriveErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return Object.prototype.hasOwnProperty.call(MESSAGES, code) ? MESSAGES[code]! : MESSAGES.unknown!;
}
