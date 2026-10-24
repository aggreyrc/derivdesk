import { createHash, randomBytes } from "node:crypto";

// RFC 7636 (PKCE, S256) + a CSRF `state` — generated server-side, per request.

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url"); // 43 chars, within the 43–128 range Deriv requires
}

export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function generateState(): string {
  return randomBytes(16).toString("hex");
}
