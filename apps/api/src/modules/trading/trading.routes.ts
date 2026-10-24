import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { quoteLimiter, tradeLimiter } from "../../middleware/rateLimiter.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { getHistory, getPortfolio, postBuy, postProposal, postSell } from "./trading.controller.js";

export const tradingRouter = Router();

tradingRouter.use(requireAuth);

tradingRouter.post("/proposal", quoteLimiter, asyncHandler(postProposal));
tradingRouter.post("/buy", tradeLimiter, asyncHandler(postBuy));
tradingRouter.post("/sell", tradeLimiter, asyncHandler(postSell));
tradingRouter.get("/portfolio", asyncHandler(getPortfolio));
tradingRouter.get("/history", asyncHandler(getHistory));
