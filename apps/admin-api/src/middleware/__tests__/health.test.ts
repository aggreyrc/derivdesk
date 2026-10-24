import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createReadyHandler } from "../health.js";

const app = (deps: Parameters<typeof createReadyHandler>[0]) => express().get("/ready", createReadyHandler(deps));

describe("admin /ready", () => {
  it("200 when the database answers", async () => {
    const res = await request(app({ pingDatabase: async () => 1 })).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", database: "ok" });
  });
  it("503 with no error detail when it does not", async () => {
    const res = await request(app({ pingDatabase: async () => { throw new Error("connect ECONNREFUSED 10.1.2.3:5432"); } })).get("/ready");
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/10\.1\.2\.3|ECONNREFUSED/);
  });
  it("503 rather than hanging when the database is silent", async () => {
    expect((await request(app({ pingDatabase: () => new Promise(() => undefined), timeoutMs: 50 })).get("/ready")).status).toBe(503);
  });
});
