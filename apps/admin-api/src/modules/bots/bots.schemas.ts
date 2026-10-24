import { z } from "zod";
import { strategyDefinitionSchema } from "./strategy.schema.js";

// Stable slug, referenced from code/seeds (see BotStrategy.key in schema.prisma) — kebab-case
// only so it's safe to use as a lookup key without further sanitization anywhere it's read.
const strategyKeySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "key must be lowercase kebab-case, e.g. \"ema-rsi-macd-martingale\"");

export const createStrategySchema = z.object({
  key: strategyKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  definition: strategyDefinitionSchema,
});
export type CreateStrategyBody = z.infer<typeof createStrategySchema>;

// Every field optional — a PATCH, not a full replace. `definition` is still validated as a
// COMPLETE StrategyDefinition when present (no partial/merge semantics for it — the signal
// engine needs a self-consistent whole, not a patch applied to JSON it never sees structured).
export const updateStrategySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2000).optional(),
  definition: strategyDefinitionSchema.optional(),
});
export type UpdateStrategyBody = z.infer<typeof updateStrategySchema>;

export const setStrategyStatusSchema = z.object({
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]),
});
