import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { authLimiter } from "../../middleware/rateLimiter.js";
import {
  getAgents,
  getDepositLink,
  getHistory,
  getWithdrawalStatusHandler,
  postWithdrawal,
  postWithdrawalOtp,
} from "./payments.controller.js";

export const paymentsRouter = Router();

paymentsRouter.use(requireAuth);

paymentsRouter.get("/deposit-link", asyncHandler(getDepositLink));
paymentsRouter.get("/agents", asyncHandler(getAgents));
paymentsRouter.post("/withdraw/verification-code", authLimiter, asyncHandler(postWithdrawalOtp));
paymentsRouter.post("/withdraw", authLimiter, asyncHandler(postWithdrawal));
paymentsRouter.get("/withdraw/:requestId", asyncHandler(getWithdrawalStatusHandler));
paymentsRouter.get("/history", asyncHandler(getHistory));
