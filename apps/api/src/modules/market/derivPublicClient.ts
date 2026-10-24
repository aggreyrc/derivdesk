import type WebSocket from "ws";
import { DerivWsClient } from "./derivWsClient.js";

// Thin specialization of DerivWsClient for Deriv's PUBLIC market-data gateway
// (wss://api.derivws.com/trading/v1/options/ws/public — no auth, confirmed at
// developers.deriv.com/docs/options/ws-public/). One instance of this is shared by the
// whole backend process (see market.gateway.ts). The URL here is a fixed constant, unlike
// the authenticated client (trading/derivPrivateClient.ts) whose URL must be re-fetched
// from Deriv on every connect.
export type { DerivMessage, ConnectionStatus } from "./derivWsClient.js";

export class DerivPublicClient extends DerivWsClient {
  constructor(url: string, wsFactory?: (url: string) => WebSocket) {
    super(() => url, wsFactory);
  }
}
