import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// A stand-in for the database: no admin exists, and it can be switched to "down".
const db = vi.hoisted(() => ({ down: false, lookups: 0 }));
vi.mock("./lib/prisma.js", () => ({
  prisma: {
    adminUser: {
      findUnique: async () => {
        db.lookups++;
        if (db.down) throw new Error("connection terminated");
        return null;
      },
    },
    adminSession: {
      findUnique: async () => {
        if (db.down) throw new Error("connection terminated");
        return null;
      },
    },
    auditLog: { create: async () => ({}) },
  },
}));

import { createApp } from "./app.js";

beforeEach(() => {
  db.down = false;
  db.lookups = 0;
});

describe("admin HTTP hardening", () => {
  const app = createApp();

  it("attaches a correlation id and echoes only a sane inbound one", async () => {
    expect((await request(app).get("/health")).headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect((await request(app).get("/health").set("X-Request-Id", "trace-abc12345")).headers["x-request-id"]).toBe("trace-abc12345");
    expect((await request(app).get("/health").set("X-Request-Id", "bad id\"<x>")).headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("answers malformed JSON with 400 and an oversized body with 413, not 500", async () => {
    const bad = await request(app).post("/api/admin/auth/login").set("Content-Type", "application/json").send("{nope");
    expect(bad.status).toBe(400);
    const big = await request(app)
      .post("/api/admin/auth/login")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ email: "a@b.co", password: "x".repeat(400_000) }));
    expect(big.status).toBe(413);
  });

  it("turns a database failure inside requireAdminAuth into a per-request 500 instead of an unhandled rejection", async () => {
    db.down = true;
    const res = await request(app).get("/api/admin/overview").set("Cookie", "derivdesk_admin_session=11111111-1111-1111-1111-111111111111");
    expect(res.status).toBe(500);
    expect(res.body.error.message).not.toMatch(/connection terminated/);
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("refuses every admin route without a session", async () => {
    for (const [method, path] of [["get", "/api/admin/users"], ["get", "/api/admin/audit-log"], ["get", "/api/admin/bot-strategies"], ["patch", "/api/admin/feature-flags/x"]] as const) {
      const res = await request(app)[method](path);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("stops checking credentials once an account+IP has failed too many times (then answers 429)", async () => {
    const attempt = () => request(app).post("/api/admin/auth/login").send({ email: "victim@example.com", password: "guess" });
    // The route's own per-IP limiter (5/min) would trip first, so drive the throttle directly
    // through its own module as well as the route: the route must consult it before the database.
    const { loginThrottle } = await import("./lib/loginThrottle.js");
    // supertest connects over loopback; which spelling Node reports depends on the host's IPv6 setup.
    for (const ip of ["::ffff:127.0.0.1", "127.0.0.1", "::1"]) for (let i = 0; i < 5; i++) loginThrottle.recordFailure("victim@example.com", ip);
    db.lookups = 0;
    const res = await attempt();
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("TooManyAttempts");
    expect(db.lookups).toBe(0); // credentials were never even looked up
  });
});
