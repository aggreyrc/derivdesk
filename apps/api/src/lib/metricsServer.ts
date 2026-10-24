import { createServer, type Server } from "node:http";
import { renderMetrics, type GaugeSources } from "./metrics.js";

/** Starts the internal-only metrics listener. Unauthenticated BY DESIGN: bind it to a network only
 *  your monitoring can reach and never publish the port (docs/operations.md). Returns the server. */
export function startMetricsServer(port: number, sources: GaugeSources, host = "0.0.0.0"): Server {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(renderMetrics(sources));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, host);
  return server;
}
