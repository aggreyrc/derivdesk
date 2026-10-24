import type { RequestHandler } from "express";

// A deliberately small Prometheus-text exporter (no dependency): the numbers an operator needs to
// alert on, nothing per-user and nothing per-route (so no cardinality blow-up and no data about
// people). Served only on the separate internal METRICS_PORT listener — never on the public port.

const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

class HttpMetrics {
  readonly byStatusClass = new Map<string, number>();
  readonly bucketCounts = new Array<number>(BUCKETS.length).fill(0);
  count = 0;
  sum = 0;

  observe(statusCode: number, seconds: number) {
    const cls = `${Math.floor(statusCode / 100)}xx`;
    this.byStatusClass.set(cls, (this.byStatusClass.get(cls) ?? 0) + 1);
    this.count++;
    this.sum += seconds;
    BUCKETS.forEach((le, i) => {
      if (seconds <= le) this.bucketCounts[i]!++;
    });
  }
}

export const httpMetrics = new HttpMetrics();

export const httpMetricsMiddleware: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    httpMetrics.observe(res.statusCode, Number(process.hrtime.bigint() - start) / 1e9);
  });
  next();
};

export interface GaugeSources {
  wsConnections: () => number;
  botRunnerIsLeader: () => boolean;
  botsAttached: () => number;
  derivMarketConnected: () => boolean;
}

export function renderMetrics(g: GaugeSources, m: HttpMetrics = httpMetrics): string {
  const out: string[] = [];
  const metric = (name: string, type: "gauge" | "counter" | "histogram", help: string) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  };

  metric("derivdesk_http_requests_total", "counter", "HTTP responses by status class");
  for (const [cls, n] of [...m.byStatusClass.entries()].sort()) out.push(`derivdesk_http_requests_total{status_class="${cls}"} ${n}`);

  metric("derivdesk_http_request_duration_seconds", "histogram", "HTTP request latency");
  BUCKETS.forEach((le, i) => out.push(`derivdesk_http_request_duration_seconds_bucket{le="${le}"} ${m.bucketCounts[i]}`));
  out.push(`derivdesk_http_request_duration_seconds_bucket{le="+Inf"} ${m.count}`);
  out.push(`derivdesk_http_request_duration_seconds_sum ${m.sum}`, `derivdesk_http_request_duration_seconds_count ${m.count}`);

  metric("derivdesk_ws_connections", "gauge", "Open browser WebSocket connections");
  out.push(`derivdesk_ws_connections ${g.wsConnections()}`);
  metric("derivdesk_bot_runner_leader", "gauge", "1 if this process holds the bot-runner lease");
  out.push(`derivdesk_bot_runner_leader ${g.botRunnerIsLeader() ? 1 : 0}`);
  metric("derivdesk_bots_attached", "gauge", "Bots this process is currently evaluating");
  out.push(`derivdesk_bots_attached ${g.botsAttached()}`);
  metric("derivdesk_deriv_market_connected", "gauge", "1 if the shared Deriv public market-data connection is up");
  out.push(`derivdesk_deriv_market_connected ${g.derivMarketConnected() ? 1 : 0}`);

  metric("derivdesk_process_uptime_seconds", "gauge", "Process uptime");
  out.push(`derivdesk_process_uptime_seconds ${process.uptime()}`);
  metric("derivdesk_process_resident_memory_bytes", "gauge", "Resident set size");
  out.push(`derivdesk_process_resident_memory_bytes ${process.memoryUsage().rss}`);
  return out.join("\n") + "\n";
}
