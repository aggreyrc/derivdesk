import type WebSocket from "ws";
import { DerivWsClient, type DerivMessage } from "../market/derivWsClient.js";
import { logger } from "../../lib/logger.js";

// Authenticated per-user Deriv connection. Two things make this different from
// DerivPublicClient:
//
// 1. The URL is a one-time-password URL that must be freshly requested from Deriv's REST
//    API (DerivClient.requestOtp) on EVERY connect, including every reconnect — it cannot
//    be cached or reused, unlike the public client's fixed URL. `otpUrlProvider` is called
//    fresh each time DerivWsClient.open() runs.
//
// 2. UNRESOLVED CONTRADICTION in Deriv's current docs (flagged in docs/phase1-architecture.md
//    and the Phase 5 README section — a pre-production verification item): the ws-real/
//    ws-demo pages describe the OTP-issued URL as fully self-authenticating (no further
//    `authorize` call needed), but the best-practices page's example still sends an
//    `authorize` message with an access token after connecting. Rather than guess which
//    reading is correct, this class does BOTH: it connects on the OTP URL AND sends a
//    defensive `authorize` afterward, and records which outcome actually happened
//    (`lastAuthorizeOutcome`) so this can be resolved empirically against a live Deriv app
//    before Phase 5 goes to production. If `authorize` is rejected/unsupported, the
//    connection is NOT closed — we proceed on the OTP URL's own authentication, which is
//    the documented primary mechanism.
export class DerivPrivateClient extends DerivWsClient {
  lastAuthorizeOutcome: "accepted" | "rejected" | "pending" | null = null;

  constructor(
    otpUrlProvider: () => Promise<string>,
    private readonly getAccessToken: () => Promise<string>,
    wsFactory?: (url: string) => WebSocket,
  ) {
    super(otpUrlProvider, wsFactory);
    this.onReconnect = () => void this.authorizeDefensively();
  }

  private async authorizeDefensively() {
    this.lastAuthorizeOutcome = "pending";
    try {
      const token = await this.getAccessToken();
      const res: DerivMessage = await this.request({ authorize: token });
      this.lastAuthorizeOutcome = res.error ? "rejected" : "accepted";
      logger.info({ outcome: this.lastAuthorizeOutcome }, "defensive `authorize` on OTP-issued Deriv connection");
    } catch (err) {
      this.lastAuthorizeOutcome = "rejected";
      logger.info(
        { reason: err instanceof Error ? err.message : err },
        "defensive `authorize` was rejected/unsupported on OTP-issued connection — proceeding on OTP auth alone",
      );
    }
  }
}
