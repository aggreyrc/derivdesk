// Where the API lives. Two supported deployments:
//   - same origin (production): VITE_API_BASE_URL="" — the web server proxies /api and /ws to the
//     API, so there is no CORS, cookies stay same-site, and the CSP can say connect-src 'self'.
//   - separate origin (local dev): VITE_API_BASE_URL=http://localhost:4000.
// An EMPTY string is a deliberate, valid value (hence `??`, not `||`).
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

/** The WebSocket endpoint for a given API base. A relative (empty) base resolves against the page
 *  origin, upgrading to wss:// on https pages. Pure so it can be unit-tested. */
export function buildWsUrl(apiBase: string, loc: { protocol: string; host: string }): string {
  if (apiBase === "") return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/ws`;
  return apiBase.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws";
}
