import { z } from "zod";

// Our own REST request validation. `currency` is never accepted from the client — it always
// comes from the session's active Deriv account, same rule as trading.schemas.ts's
// proposalBodySchema. Deriv's `amount` field is a decimal STRING (see deriv.client.ts); we
// accept a number from the UI and format it server-side so there's one place that decides
// the string format, not every caller.

export const agentsQuerySchema = z.object({
  country: z.string().length(2).optional(), // ISO 3166-1 alpha-2, lowercase per the verified schema
});

export const withdrawalOtpRequestSchema = z.object({
  agentId: z.number().int().positive(),
  amount: z.number().positive(),
});
export type WithdrawalOtpRequestBody = z.infer<typeof withdrawalOtpRequestSchema>;

export const withdrawalRequestSchema = z.object({
  agentId: z.number().int().positive(),
  amount: z.number().positive(),
  verificationCode: z.string().regex(/^\d{6}$/, "verificationCode must be exactly 6 digits"),
  notes: z.string().max(500).optional(),
});
export type WithdrawalRequestBody = z.infer<typeof withdrawalRequestSchema>;
