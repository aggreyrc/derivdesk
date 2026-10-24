import { getDerivSettings } from "../../lib/config.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { recordAudit } from "../../lib/audit.js";
import { DerivClient } from "../deriv/deriv.client.js";
import { getValidAccessToken, type DerivDeps } from "../deriv/deriv.service.js";
import { prisma } from "../../lib/prisma.js";
import { TradingSessionManager, type TokenProvider } from "./trading.sessionManager.js";

// One shared TradingSessionManager for the whole process, mirroring market.instance.ts's
// pooled MarketDataGateway — except here each (user, account) pair gets its OWN
// authenticated connection internally (see trading.sessionManager.ts); this module just
// avoids constructing more than one manager, which would otherwise duplicate every
// session's bookkeeping.
//
// Deliberately lazy: Deriv settings may not be configured yet at boot (same tolerance as
// deriv.controller.ts's getDeps()), so construction is deferred to first use inside a
// request, by which point requireAuth has already run.

function buildDerivDeps(): DerivDeps {
  const settings = getDerivSettings();
  if (!settings) {
    throw new HttpError(503, "DerivNotConfigured", "Deriv integration is not configured on this server");
  }
  return { db: prisma, client: new DerivClient(settings), audit: recordAudit, settings };
}

const tokenProvider: TokenProvider = {
  // Reuses the exact same refresh-aware token logic the REST /api/deriv endpoints use — a
  // trading connection never gets its own, separate notion of "is this token still valid".
  getAccessToken: (userId: string) => getValidAccessToken(buildDerivDeps(), userId),
};

let instance: TradingSessionManager | null = null;

export function getTradingSessionManager(): TradingSessionManager {
  if (!instance) {
    const settings = getDerivSettings();
    if (!settings) {
      throw new HttpError(503, "DerivNotConfigured", "Deriv integration is not configured on this server");
    }
    instance = new TradingSessionManager(new DerivClient(settings), tokenProvider);
  }
  return instance;
}
