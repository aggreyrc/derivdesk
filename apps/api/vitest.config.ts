import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Safe, fake values so config.ts's fail-fast validation passes in tests.
    // No real database or secret is ever involved in unit tests.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      CORS_ORIGIN: "http://localhost:5173",
      SESSION_SECRET: "test-secret-value-not-for-real-use",
      TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=", // 32 bytes, base64 — test-only
      DERIV_PUBLIC_WS_URL: "wss://fake.invalid/ws",
    },
  },
});
