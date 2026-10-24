import type { PrismaClient } from "@derivdesk/db";
import { HttpError } from "../../middleware/errorHandler.js";
import { verifyPassword } from "../../lib/password.js";
import { verifyTotp } from "../../lib/totp.js";
import { sealTotpState, unsealTotpState } from "../../lib/totpState.js";

// There is no registerAdmin() here on purpose — admin accounts are created
// out-of-band via `npm run create-admin` (scripts/create-admin.ts), never
// through a public HTTP endpoint. An open admin-registration route would
// undo the entire point of separating this deployment. Authenticator enrolment is
// out-of-band too: `npm run enroll-totp`.

/** An HttpError that also says WHY, so the controller can audit/throttle without the client ever
 *  seeing more than the generic message. */
export class LoginFailure extends HttpError {
  constructor(
    status: number,
    code: string,
    message: string,
    public readonly adminId: string | null,
    public readonly reason: "unknown_account" | "bad_password" | "disabled" | "totp_not_enrolled" | "totp_missing" | "bad_totp" | "totp_replay",
  ) {
    super(status, code, message);
  }
}

// Real bcrypt hash (cost 12) of a throwaway string — burned against when the email is unknown so
// unknown-account and wrong-password take the same time (no account-enumeration oracle).
const DUMMY_HASH = "$2a$12$4rrygYH3kXGYn9VmntJreuBu.2ghj68SNqmNIDuRJBc8oXI/Jnfea";

export interface AuthOptions {
  requireTotp: boolean;
  now?: () => number;
}

export async function authenticateAdmin(db: PrismaClient, email: string, password: string, totpCode: string | undefined, opts: AuthOptions) {
  const admin = await db.adminUser.findUnique({ where: { email } });
  if (!admin) {
    await verifyPassword(password, DUMMY_HASH);
    throw new LoginFailure(401, "InvalidCredentials", "Incorrect email or password", null, "unknown_account");
  }

  if (!(await verifyPassword(password, admin.passwordHash))) {
    throw new LoginFailure(401, "InvalidCredentials", "Incorrect email or password", admin.id, "bad_password");
  }

  if (admin.status !== "ACTIVE") {
    throw new LoginFailure(403, "AccountDisabled", "This admin account is disabled", admin.id, "disabled");
  }

  // ---- second factor (only reached with a correct password) ----------------------------------
  if (!admin.totpSecretEnc) {
    if (opts.requireTotp) {
      throw new LoginFailure(
        403,
        "TotpEnrollmentRequired",
        "Two-factor authentication is required and not set up for this account. Ask an operator to run `npm run enroll-totp`.",
        admin.id,
        "totp_not_enrolled",
      );
    }
    return admin; // local development only — refused in production by lib/config.ts
  }

  if (!totpCode) {
    throw new LoginFailure(401, "TotpRequired", "Enter the 6-digit code from your authenticator app", admin.id, "totp_missing");
  }

  const state = unsealTotpState(admin.totpSecretEnc); // a corrupt/foreign-key blob is a server fault: throws -> 500, never a bypass
  const step = verifyTotp(state.secret, totpCode, (opts.now ?? Date.now)());
  if (step === null) {
    throw new LoginFailure(401, "InvalidTotp", "Invalid or expired authentication code", admin.id, "bad_totp");
  }
  if (state.lastStep !== null && step <= state.lastStep) {
    throw new LoginFailure(401, "InvalidTotp", "Invalid or expired authentication code", admin.id, "totp_replay");
  }

  // Compare-and-set on the exact ciphertext we read: if a concurrent login already consumed this
  // (or any) code, the stored blob changed and this matches 0 rows.
  const swapped = await db.adminUser.updateMany({
    where: { id: admin.id, totpSecretEnc: admin.totpSecretEnc },
    data: { totpSecretEnc: sealTotpState({ ...state, lastStep: step }) },
  });
  if (swapped.count !== 1) {
    throw new LoginFailure(401, "InvalidTotp", "Invalid or expired authentication code", admin.id, "totp_replay");
  }

  return admin;
}
