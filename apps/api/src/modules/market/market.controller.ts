import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { marketDataGateway } from "./market.instance.js";
import { addToWatchlist, listWatchlistSymbols, removeFromWatchlist } from "./watchlist.service.js";
import { candlesQuerySchema, contractsForQuerySchema, watchlistAddSchema } from "./market.schemas.js";

export async function getSymbols(_req: Request, res: Response) {
  const symbols = await marketDataGateway.getActiveSymbols();
  res.json({ data: symbols });
}

export async function getCandles(req: Request, res: Response) {
  const parsed = candlesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new HttpError(400, "ValidationError", "symbol is required; granularity/count must be positive numbers");
  const { symbol, granularity, count } = parsed.data;
  const result = await marketDataGateway.getCandles(symbol, granularity, count);
  res.json({ data: result });
}

export async function getStatus(_req: Request, res: Response) {
  res.json({ data: { status: marketDataGateway.getStatus() } });
}

// Backs the trade ticket's "which contract types / parameters can I actually offer for this
// symbol" question — the frontend must build its form from THIS, never from a hardcoded
// list, so it can never construct a proposal Deriv would reject as unsupported.
export async function getContractsFor(req: Request, res: Response) {
  const parsed = contractsForQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new HttpError(400, "ValidationError", "symbol is required");
  const available = await marketDataGateway.getContractsFor(parsed.data.symbol);
  res.json({ data: available });
}

export async function getWatchlist(req: Request, res: Response) {
  const symbols = await listWatchlistSymbols(prisma, req.userId!);
  res.json({ data: symbols });
}

export async function postWatchlist(req: Request, res: Response) {
  const parsed = watchlistAddSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "ValidationError", "symbol is required");
  const symbols = await addToWatchlist(prisma, req.userId!, parsed.data.symbol);
  res.status(201).json({ data: symbols });
}

export async function deleteWatchlistSymbol(req: Request, res: Response) {
  const symbol = req.params.symbol;
  if (!symbol) throw new HttpError(400, "ValidationError", "symbol is required");
  const symbols = await removeFromWatchlist(prisma, req.userId!, symbol);
  res.json({ data: symbols });
}
