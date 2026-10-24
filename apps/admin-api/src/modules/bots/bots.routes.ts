import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAdminAuth } from "../../middleware/requireAdminAuth.js";
import { createStrategy, deleteStrategy, getStrategy, listStrategies, setStrategyStatus, updateStrategy } from "./bots.controller.js";

export const botsRouter = Router();
botsRouter.use(requireAdminAuth);

botsRouter.get("/bot-strategies", asyncHandler(listStrategies));
botsRouter.get("/bot-strategies/:id", asyncHandler(getStrategy));
botsRouter.post("/bot-strategies", asyncHandler(createStrategy));
botsRouter.patch("/bot-strategies/:id", asyncHandler(updateStrategy));
botsRouter.patch("/bot-strategies/:id/status", asyncHandler(setStrategyStatus));
botsRouter.delete("/bot-strategies/:id", asyncHandler(deleteStrategy));
