import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4100),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  CORS_ORIGIN: z.string().min(1, "CORS_ORIGIN is required"),
  // Reserved (sessions are opaque random ids looked up server-side); still required so a future
  // signed-cookie feature cannot ship with a blank.
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
  // Reverse-proxy hop count (0 = none). A bounded number, never a blanket `true`: see apps/api.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

  // AES-256-GCM key for the TOTP secrets in admin_users.totp_secret_enc: 32 random bytes, base64
  // (`openssl rand -base64 32`). DELIBERATELY a different key from apps/api's TOKEN_ENCRYPTION_KEY:
  // this deployment must never hold the key that protects clients' Deriv tokens.
  ADMIN_TOTP_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "ADMIN_TOTP_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
  // Extra keys accepted for DECRYPTION ONLY (comma-separated, each 32 bytes base64), for rotating
  // ADMIN_TOTP_ENCRYPTION_KEY without locking admins out — docs/operations.md. Encryption always
  // uses ADMIN_TOTP_ENCRYPTION_KEY alone.
  ADMIN_TOTP_ENCRYPTION_KEYS_EXTRA: z
    .string()
    .optional()
    .refine(
      (v) => !v || v.split(",").every((k) => Buffer.from(k.trim(), "base64").length === 32),
      "ADMIN_TOTP_ENCRYPTION_KEYS_EXTRA must be comma-separated 32-byte base64 keys",
    ),
  // When "true" (the default) an admin with NO enrolled authenticator cannot sign in at all —
  // 2FA is mandatory, not opt-in. "false" exists only so a developer can run locally before
  // enrolling; it is refused in production.
  ADMIN_REQUIRE_TOTP: z.enum(["true", "false"]).default("true"),
});

const guarded = schema.superRefine((cfg, ctx) => {
  if (cfg.NODE_ENV !== "production") return;
  if (/change_me/i.test(cfg.DATABASE_URL)) {
    ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "DATABASE_URL still uses the default change_me_* role password — set a real one (scripts/apply-roles.sh)" });
  }
  if (!cfg.CORS_ORIGIN.startsWith("https://")) {
    ctx.addIssue({ code: "custom", path: ["CORS_ORIGIN"], message: "CORS_ORIGIN must be an https:// origin in production (the session cookie is Secure-only)" });
  }
  if (/^replace_with|^test-secret/i.test(cfg.SESSION_SECRET)) {
    ctx.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "SESSION_SECRET is still a placeholder" });
  }
  if (cfg.ADMIN_REQUIRE_TOTP !== "true") {
    ctx.addIssue({ code: "custom", path: ["ADMIN_REQUIRE_TOTP"], message: "ADMIN_REQUIRE_TOTP must be true in production" });
  }
});

const parsed = guarded.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("apps/admin-api failed to start: invalid environment configuration");
}

export const config = parsed.data;
