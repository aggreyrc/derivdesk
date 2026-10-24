import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { logout, me } from "./auth.controller.js";

// There is no register and no password login: accounts are created, and sessions issued, only by
// signing in with Deriv (GET /api/deriv/login -> /api/deriv/callback).
export const authRouter = Router();

authRouter.post("/logout", asyncHandler(logout));
authRouter.get("/me", asyncHandler(me));
