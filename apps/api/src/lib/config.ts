import "dotenv/config";
import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  CORS_ORIGIN: z.string().min(1, "CORS_ORIGIN is required"),
  // Where to send the browser after the Deriv OAuth callback (the client SPA).
  WEB_APP_URL: z.string().url().default("http://localhost:5173"),
  // Reserved: sessions are opaque random ids looked up server-side, so nothing signs with this
  // today. Still required so a future signed-cookie/CSRF-token feature can't ship with a blank.
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
  // Number of reverse-proxy hops in front of this API (0 = none). Express only believes
  // X-Forwarded-For for that many hops; a boolean "trust everything" is deliberately not offered
  // because it lets any client spoof its IP past the rate limiters. Behind a load balancer set 1.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

  // AES-256-GCM key for tokens at rest: 32 random bytes, base64 (`openssl rand -base64 32`).
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
  // Extra keys accepted for DECRYPTION ONLY (comma-separated, each 32 bytes base64). Used to rotate
  // TOKEN_ENCRYPTION_KEY without downtime — see docs/operations.md "Rotating the encryption key".
  // Everything is always ENCRYPTED with TOKEN_ENCRYPTION_KEY alone.
  TOKEN_ENCRYPTION_KEYS_EXTRA: z
    .string()
    .optional()
    .refine(
      (v) => !v || v.split(",").every((k) => Buffer.from(k.trim(), "base64").length === 32),
      "TOKEN_ENCRYPTION_KEYS_EXTRA must be comma-separated 32-byte base64 keys",
    ),

  // Deriv. Optional at boot so the rest of the app runs without a registered Deriv
  // app; the /api/deriv/connect route answers 503 until these are set.
  DERIV_CLIENT_ID: optionalString, // == the Deriv App ID (same identifier per Deriv docs)
  DERIV_CLIENT_SECRET: optionalString, // sent only if set; Deriv's reference doesn't list it for the token call
  DERIV_OAUTH_REDIRECT_URI: optionalString, // must EXACTLY match the URI registered with Deriv
  DERIV_OAUTH_SCOPES: z.string().default("trade"), // least privilege; `payment` is added in Phase 6
  DERIV_API_BASE_URL: z.string().url().default("https://api.derivws.com"),
  // Operational kill switch: set to "false" to stop the always-on bot runner from starting
  // (running bots stay RUNNING in the database and resume when it is re-enabled).
  BOT_RUNNER_ENABLED: z.enum(["true", "false"]).default("true"),
  // When set, a SECOND, unauthenticated listener serves Prometheus text at /metrics on this port.
  // Internal network only — never publish it (docs/operations.md). Unset = no metrics listener.
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  // Failover time if the bot-runner leader dies without releasing its lease (renewed every ttl/3).
  BOT_RUNNER_LEASE_TTL_MS: z.coerce.number().int().min(3000).max(300_000).default(30_000),
  DERIV_PUBLIC_WS_URL: z.string().url().default("wss://api.derivws.com/trading/v1/options/ws/public"),
  DERIV_OAUTH_AUTHORIZE_URL: z.string().url().default("https://auth.deriv.com/oauth2/auth"),
  DERIV_OAUTH_TOKEN_URL: z.string().url().default("https://auth.deriv.com/oauth2/token"),
});

// Production-only guards: refuse to boot with values that are fine on a laptop but unsafe live.
const guarded = schema.superRefine((cfg, ctx) => {
  if (cfg.NODE_ENV !== "production") return;
  if (/change_me/i.test(cfg.DATABASE_URL)) {
    ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "DATABASE_URL still uses the default change_me_* role password — set real ones (scripts/apply-roles.sh)" });
  }
  for (const key of ["CORS_ORIGIN", "WEB_APP_URL"] as const) {
    if (!cfg[key].startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: [key], message: `${key} must be an https:// origin in production (the session cookie is Secure-only)` });
    }
  }
  if (/^replace_with|^test-secret/i.test(cfg.SESSION_SECRET)) {
    ctx.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "SESSION_SECRET is still a placeholder" });
  }
});

const parsed = guarded.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loud at boot rather than limping along with undefined config.
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("apps/api failed to start: invalid environment configuration");
}

export const config = parsed.data;

export interface DerivOAuthSettings {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string;
  apiBaseUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
}

/** Returns Deriv settings, or null when the Deriv app hasn't been configured yet. */
export function getDerivSettings(): DerivOAuthSettings | null {
  if (!config.DERIV_CLIENT_ID || !config.DERIV_OAUTH_REDIRECT_URI) {
    return null;
  }
  return {
    clientId: config.DERIV_CLIENT_ID,
    clientSecret: config.DERIV_CLIENT_SECRET,
    redirectUri: config.DERIV_OAUTH_REDIRECT_URI,
    scopes: config.DERIV_OAUTH_SCOPES,
    apiBaseUrl: config.DERIV_API_BASE_URL,
    authorizeUrl: config.DERIV_OAUTH_AUTHORIZE_URL,
    tokenUrl: config.DERIV_OAUTH_TOKEN_URL,
  };
}
