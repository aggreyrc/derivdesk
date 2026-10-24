import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { authLimiter } from "../../middleware/rateLimiter.js";
import { getBotById, getBots, getBotTrades, getCatalog, patchBot, postBot, postPause, postStart, postStop, removeBot } from "./bots.controller.js";

export const botsRouter = Router();
botsRouter.use(requireAuth);

botsRouter.get("/strategies", asyncHandler(getCatalog));
botsRouter.get("/", asyncHandler(getBots));
botsRouter.post("/", asyncHandler(postBot));
botsRouter.get("/:id", asyncHandler(getBotById));
botsRouter.patch("/:id", asyncHandler(patchBot));
botsRouter.delete("/:id", asyncHandler(removeBot));
botsRouter.get("/:id/trades", asyncHandler(getBotTrades));
// Start is the real-money moment; rate-limit it like the other money-moving endpoints.
botsRouter.post("/:id/start", authLimiter, asyncHandler(postStart));
botsRouter.post("/:id/pause", asyncHandler(postPause));
botsRouter.post("/:id/stop", asyncHandler(postStop));
