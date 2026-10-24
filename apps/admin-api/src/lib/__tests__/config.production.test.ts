import { afterEach, describe, expect, it, vi } from "vitest";

const GOOD = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://derivdesk_admin:s3cretvalue@db:5432/derivdesk",
  CORS_ORIGIN: "https://admin.internal.example.com",
  SESSION_SECRET: "a-real-long-random-value-0123456789",
  ADMIN_TOTP_ENCRYPTION_KEY: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
  ADMIN_REQUIRE_TOTP: "true",
};

async function load(env: Record<string, string>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("../config.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("admin-api production config guards", () => {
  it("boots with a sound production configuration", async () => {
    expect((await load(GOOD)).config.ADMIN_REQUIRE_TOTP).toBe("true");
  });

  it("REFUSES to boot in production with 2FA switched off", async () => {
    await expect(load({ ...GOOD, ADMIN_REQUIRE_TOTP: "false" })).rejects.toThrow(/invalid environment/);
  });

  it("refuses the default change_me_* database password, a non-https origin, and a placeholder secret", async () => {
    await expect(load({ ...GOOD, DATABASE_URL: "postgresql://derivdesk_admin:change_me_admin@db:5432/x" })).rejects.toThrow(/invalid environment/);
    await expect(load({ ...GOOD, CORS_ORIGIN: "http://admin.example.com" })).rejects.toThrow(/invalid environment/);
    await expect(load({ ...GOOD, SESSION_SECRET: "replace_with_a_different_long_random_value" })).rejects.toThrow(/invalid environment/);
  });

  it("requires a 32-byte TOTP key", async () => {
    await expect(load({ ...GOOD, ADMIN_TOTP_ENCRYPTION_KEY: "c2hvcnQ=" })).rejects.toThrow(/invalid environment/);
  });

  it("allows 2FA off in development only", async () => {
    const { config } = await load({ ...GOOD, NODE_ENV: "development", ADMIN_REQUIRE_TOTP: "false", DATABASE_URL: "postgresql://x:change_me_admin@localhost/x", CORS_ORIGIN: "http://localhost:5174" });
    expect(config.ADMIN_REQUIRE_TOTP).toBe("false");
  });
});
