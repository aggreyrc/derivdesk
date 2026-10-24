import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createReadyHandler } from "../health.js";
import { httpMetrics, httpMetricsMiddleware, renderMetrics } from "../../lib/metrics.js";

const app = (deps: Parameters<typeof createReadyHandler>[0]) => {
  const a = express();
  a.get("/ready", createReadyHandler(deps));
  return a;
};

describe("/ready", () => {
  it("200 with coarse status when the database answers", async () => {
    const res = await request(app({ pingDatabase: async () => 1, runnerRole: () => "leader" })).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", database: "ok", botRunner: "leader" });
  });

  it("503 when the database query fails — and leaks no error text", async () => {
    const res = await request(app({ pingDatabase: async () => { throw new Error("password authentication failed for user derivdesk_api at 10.0.0.5"); }, runnerRole: () => "standby" })).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "not_ready", database: "unreachable", botRunner: "standby" });
    expect(JSON.stringify(res.body)).not.toMatch(/password|10\.0\.0\.5/);
  });

  it("503 (not a hang) when the database never answers", async () => {
    const res = await request(app({ pingDatabase: () => new Promise(() => undefined), runnerRole: () => "disabled", timeoutMs: 50 })).get("/ready");
    expect(res.status).toBe(503);
  });
});

describe("metrics", () => {
  const gauges = { wsConnections: () => 3, botRunnerIsLeader: () => true, botsAttached: () => 2, derivMarketConnected: () => false };

  it("renders Prometheus text with the operational gauges", () => {
    const text = renderMetrics(gauges);
    expect(text).toContain("derivdesk_ws_connections 3");
    expect(text).toContain("derivdesk_bot_runner_leader 1");
    expect(text).toContain("derivdesk_bots_attached 2");
    expect(text).toContain("derivdesk_deriv_market_connected 0");
    expect(text).toMatch(/# TYPE derivdesk_http_request_duration_seconds histogram/);
  });

  it("counts responses by status class and records latency, with no route or user labels", async () => {
    const before = httpMetrics.count;
    const a = express();
    a.use(httpMetricsMiddleware);
    a.get("/ok", (_q, r) => r.send("ok"));
    a.get("/boom", (_q, r) => r.status(500).send("x"));
    await request(a).get("/ok");
    await request(a).get("/boom?token=secret&user=someone@example.com");
    expect(httpMetrics.count).toBe(before + 2);
    const text = renderMetrics(gauges);
    expect(text).toMatch(/derivdesk_http_requests_total\{status_class="5xx"\} [1-9]/);
    expect(text).not.toMatch(/secret|someone@example\.com|\/boom/);
  });

  it("histogram buckets are cumulative", async () => {
    const text = renderMetrics(gauges);
    const counts = [...text.matchAll(/duration_seconds_bucket\{le="[\d.]+"\} (\d+)/g)].map((m) => Number(m[1]));
    expect(counts).toEqual([...counts].sort((x, y) => x - y));
  });
});
