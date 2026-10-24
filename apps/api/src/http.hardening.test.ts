import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";

// requireAuth looks the session up through prisma; make that the thing that fails, exactly as a
// dropped database connection would.
// A plain function, not vi.fn(): vitest's spy wrapper re-attaches to the rejected promise it
// returns and surfaces it as an unhandled rejection of the TEST, masking what we are checking.
const db = vi.hoisted(() => ({ down: false }));
vi.mock("./lib/prisma.js", () => ({
  prisma: {
    session: {
      findUnique: async () => {
        if (db.down) throw new Error("connection terminated");
        return null;
      },
    },
  },
}));

import { createApp } from "./app.js";

beforeEach(() => {
  db.down = false;
});

describe("HTTP hardening", () => {
  const app = createApp();

  it("attaches a correlation id to every response", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes a sane inbound X-Request-Id but replaces a hostile one", async () => {
    const ok = await request(app).get("/health").set("X-Request-Id", "trace-abc12345");
    expect(ok.headers["x-request-id"]).toBe("trace-abc12345");
    const bad = await request(app).get("/health").set("X-Request-Id", "x y\"<script>");
    expect(bad.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("answers malformed JSON with 400, not a 500", async () => {
    const res = await request(app).post("/api/auth/logout").set("Content-Type", "application/json").send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BadRequest");
  });

  it("answers an oversized body with 413, not a 500", async () => {
    const res = await request(app).post("/api/auth/logout").set("Content-Type", "application/json").send(JSON.stringify({ filler: "x".repeat(200_000) }));
    expect(res.status).toBe(413);
  });

  it("turns a database failure inside requireAuth into a 500 for that request instead of an unhandled rejection", async () => {
    db.down = true;
    const res = await request(app).get("/api/analytics/summary").set("Cookie", "derivdesk_session=11111111-1111-1111-1111-111111111111");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("InternalError");
    expect(res.body.error.message).not.toMatch(/connection terminated/); // no internals leaked
    expect(res.body.error.requestId).toBeTruthy();
  });

  it("rejects an unauthenticated call to a protected route with 401", async () => {
    const res = await request(app).post("/api/trading/buy").send({});
    expect(res.status).toBe(401);
  });

  it("does not advertise the framework", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
