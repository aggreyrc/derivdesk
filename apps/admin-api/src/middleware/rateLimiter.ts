import rateLimit from "express-rate-limit";

// Admin traffic is low-volume and high-trust relative to the client app, so
// limits here exist mainly to blunt credential stuffing against admin login,
// not to shape normal usage.
export const standardLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RateLimited", message: "Too many attempts — try again shortly" } },
});

// Readiness probe: generous for an orchestrator, still bounded because it touches the database.
export const readyLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: false, legacyHeaders: false });
