import { decryptSecret, encryptSecret } from "./crypto.js";

// What lives (encrypted) in admin_users.totp_secret_enc:  { v:1, secret:<base32>, lastStep:<int|null> }.
//
// `lastStep` is the time-step of the last code accepted, which is how a code is made single-use:
// anything at or below it is refused, so a code shoulder-surfed or captured from logs/proxy cannot
// be replayed inside its ~90 s validity window. It is kept INSIDE the encrypted blob (rather than a
// new column) so enabling this needs no schema migration and no change to the generated Prisma
// client; the update is a compare-and-set on the old ciphertext, which makes it atomic — two
// concurrent logins presenting the same code cannot both succeed.

export interface TotpState {
  v: 1;
  secret: string;
  lastStep: number | null;
}

export function sealTotpState(state: TotpState): string {
  return encryptSecret(JSON.stringify(state));
}

export function unsealTotpState(blob: string): TotpState {
  const parsed = JSON.parse(decryptSecret(blob)) as Partial<TotpState>;
  if (parsed.v !== 1 || typeof parsed.secret !== "string" || !(parsed.lastStep === null || typeof parsed.lastStep === "number")) {
    throw new Error("Unrecognized TOTP state");
  }
  return { v: 1, secret: parsed.secret, lastStep: parsed.lastStep };
}
