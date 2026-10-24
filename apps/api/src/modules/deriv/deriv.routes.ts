import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { authLimiter } from "../../middleware/rateLimiter.js";
import { accounts, activate, callback, connect, disconnectConnection, refresh, startSignIn } from "./deriv.controller.js";

export const derivRouter = Router();

// Sign-in/sign-up and its callback are deliberately NOT behind requireAuth — see deriv.controller.ts.
derivRouter.get("/login", authLimiter, asyncHandler(startSignIn));
derivRouter.get("/callback", authLimiter, asyncHandler(callback));

derivRouter.use(requireAuth);
derivRouter.get("/connect", authLimiter, asyncHandler(connect));
derivRouter.get("/accounts", asyncHandler(accounts));
derivRouter.post("/accounts/refresh", authLimiter, asyncHandler(refresh));
derivRouter.post("/accounts/:id/activate", asyncHandler(activate));
derivRouter.delete("/connection", asyncHandler(disconnectConnection));
