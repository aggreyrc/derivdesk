import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { getCandles, getContractsFor, getStatus, getSymbols, getWatchlist, postWatchlist, deleteWatchlistSymbol } from "./market.controller.js";

export const marketRouter = Router();

// Deriv doesn't require auth for this data, but WE do: it protects the shared rate-limit
// budget (docs/phase1-architecture.md §2) from being consumable by anonymous traffic.
marketRouter.use(requireAuth);

marketRouter.get("/symbols", asyncHandler(getSymbols));
marketRouter.get("/candles", asyncHandler(getCandles));
marketRouter.get("/status", asyncHandler(getStatus));
marketRouter.get("/contracts-for", asyncHandler(getContractsFor));

marketRouter.get("/watchlist", asyncHandler(getWatchlist));
marketRouter.post("/watchlist", asyncHandler(postWatchlist));
marketRouter.delete("/watchlist/:symbol", asyncHandler(deleteWatchlistSymbol));
