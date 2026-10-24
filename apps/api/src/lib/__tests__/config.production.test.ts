import { afterEach, describe, expect, it, vi } from "vitest";

const GOOD = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://derivdesk_api:s3cretvalue@db:5432/derivdesk",
  CORS_ORIGIN: "https://app.example.com",
  WEB_APP_URL: "https://app.example.com",
  SESSION_SECRET: "a-real-long-random-value-0123456789",
  TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
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

describe("production config guards", () => {
  it("boots with a sound production configuration", async () => {
    const { config } = await load(GOOD);
    expect(config.NODE_ENV).toBe("production");
  });

  it("refuses to boot with the default change_me_* database password", async () => {
    await expect(load({ ...GOOD, DATABASE_URL: "postgresql://derivdesk_api:change_me_api@db:5432/derivdesk" })).rejects.toThrow(/invalid environment/);
  });

  it("refuses a non-https CORS origin in production", async () => {
    await expect(load({ ...GOOD, CORS_ORIGIN: "http://app.example.com" })).rejects.toThrow(/invalid environment/);
  });

  it("refuses a placeholder SESSION_SECRET in production", async () => {
    await expect(load({ ...GOOD, SESSION_SECRET: "replace_with_a_long_random_value" })).rejects.toThrow(/invalid environment/);
  });

  it("does not apply those guards outside production", async () => {
    const { config } = await load({ ...GOOD, NODE_ENV: "development", DATABASE_URL: "postgresql://derivdesk_api:change_me_api@localhost:5432/d", CORS_ORIGIN: "http://localhost:5173", WEB_APP_URL: "http://localhost:5173" });
    expect(config.NODE_ENV).toBe("development");
  });

  it("TRUST_PROXY is a bounded hop count, never a boolean", async () => {
    expect((await load({ ...GOOD, TRUST_PROXY: "1" })).config.TRUST_PROXY).toBe(1);
    await expect(load({ ...GOOD, TRUST_PROXY: "true" })).rejects.toThrow(/invalid environment/);
  });
});
