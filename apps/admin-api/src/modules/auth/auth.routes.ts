import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { authLimiter } from "../../middleware/rateLimiter.js";
import { login, logout, me } from "./auth.controller.js";

export const authRouter = Router();

authRouter.post("/login", authLimiter, asyncHandler(login));
authRouter.post("/logout", asyncHandler(logout));
authRouter.get("/me", asyncHandler(me));
