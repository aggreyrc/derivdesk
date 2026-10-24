import { MarketDataGateway } from "./market.gateway.js";
import { config } from "../../lib/config.js";

// One shared gateway for the whole process — this IS the "pooled public connection" from
// docs/phase1-architecture.md §3. Every app user's market data flows through this single
// instance; do not construct a second one (that would double the outbound rate-limit budget
// usage for no benefit, and Deriv wouldn't distinguish it from a second, unrelated app).
export const marketDataGateway = new MarketDataGateway(config.DERIV_PUBLIC_WS_URL);
