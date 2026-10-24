import { z } from "zod";
import { botRiskParamsSchema } from "./botParams.js";

const symbolSchema = z.string().min(2).max(30).regex(/^[A-Za-z0-9_]+$/, "symbol may only contain letters, digits and underscores");

export const createBotSchema = z.object({
  strategyId: z.string().min(1),
  accountId: z.string().min(1), // DerivAccount.id — ownership verified server-side, never trusted
  name: z.string().min(1).max(100),
  symbol: symbolSchema,
  riskParams: botRiskParamsSchema,
  // Must be literally true to create a bot on a REAL account; ignored for demo accounts.
  confirmReal: z.boolean().default(false),
});
export type CreateBotBody = z.infer<typeof createBotSchema>;

// The account and strategy are fixed once created (a different account/strategy is a new bot —
// otherwise a "demo" bot could be silently re-pointed at real money).
export const updateBotSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    symbol: symbolSchema.optional(),
    riskParams: botRiskParamsSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update" });
export type UpdateBotBody = z.infer<typeof updateBotSchema>;

export const startBotSchema = z.object({ confirmReal: z.boolean().default(false) });

export const tradesQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
