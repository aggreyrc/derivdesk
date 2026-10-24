import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAdminAuth } from "../../middleware/requireAdminAuth.js";
import {
  overview,
  listUsers,
  setUserStatus,
  listConnections,
  listWithdrawals,
  listAuditLog,
  listFeatureFlags,
  setFeatureFlag,
} from "./ops.controller.js";

export const opsRouter = Router();
opsRouter.use(requireAdminAuth);

opsRouter.get("/overview", asyncHandler(overview));

opsRouter.get("/users", asyncHandler(listUsers));
opsRouter.patch("/users/:id/status", asyncHandler(setUserStatus));

opsRouter.get("/connections", asyncHandler(listConnections));

opsRouter.get("/withdrawals", asyncHandler(listWithdrawals));

opsRouter.get("/audit-log", asyncHandler(listAuditLog));

opsRouter.get("/feature-flags", asyncHandler(listFeatureFlags));
opsRouter.patch("/feature-flags/:key", asyncHandler(setFeatureFlag));
