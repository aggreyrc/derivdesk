import rateLimit from "express-rate-limit";

// Generous default for normal API traffic.
export const standardLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Readiness probe: generous for a load balancer / orchestrator, still bounded because it touches the database.
export const readyLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: false, legacyHeaders: false });

// Tighter limit on auth endpoints specifically — this is what actually
// matters for credential-stuffing/brute-force resistance.
export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RateLimited", message: "Too many attempts — try again shortly" } },
});

// --- Per-USER limiters for money-moving / quota-consuming endpoints --------------------------
// The IP-keyed limiters above can't tell two users behind one NAT apart, nor stop one user
// rotating IPs. These key on the verified session user (requireAuth runs first on these
// routers), so the budget follows the account.
const byUser = (req: { userId?: string; ip?: string }) => req.userId ?? `ip:${req.ip ?? "unknown"}`;

// Quote requests draw on the shared Deriv rate-limit budget (docs/phase1-architecture.md §2).
export const quoteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  keyGenerator: byUser,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RateLimited", message: "Too many quote requests — slow down" } },
});

// buy / sell: real money. Far above human use, far below a runaway script.
export const tradeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  keyGenerator: byUser,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RateLimited", message: "Too many trade requests — slow down" } },
});
