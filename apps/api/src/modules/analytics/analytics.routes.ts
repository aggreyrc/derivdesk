import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { getPerformanceHandler, getSummaryHandler, getTechnicalHandler } from "./analytics.controller.js";

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

analyticsRouter.get("/summary", asyncHandler(getSummaryHandler));
analyticsRouter.get("/performance", asyncHandler(getPerformanceHandler));
analyticsRouter.get("/technical", asyncHandler(getTechnicalHandler));
