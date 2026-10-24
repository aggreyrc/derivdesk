import { z } from "zod";
import { contractTypeSchema } from "../market/market.schemas.js";

// All shapes here verified against developers.deriv.com/comparison/ (current, non-legacy
// API) — see docs/phase1-architecture.md §2 and the Phase 5 README section for the specific
// pages checked. Numeric fields that Deriv documents as `string | number` stay a union here
// rather than being coerced to `number`, so we never silently misrepresent a value Deriv
// sent as a precise decimal string.

export const portfolioContractSchema = z.object({
  contract_id: z.number(),
  contract_type: z.string(),
  underlying_symbol: z.string(),
  buy_price: z.union([z.number(), z.string()]),
  payout: z.union([z.number(), z.string()]).optional(),
  purchase_time: z.number(),
  date_expiry: z.number().optional(),
  longcode: z.string().optional(),
});
export type PortfolioContract = z.infer<typeof portfolioContractSchema>;

export const portfolioResponseSchema = z.object({
  msg_type: z.literal("portfolio"),
  portfolio: z.object({ contracts: z.array(portfolioContractSchema) }),
});

// proposal_open_contract's current (non-legacy) shape only guarantees contract_id,
// contract_type and currency — verified at developers.deriv.com/comparison/proposal_open_contract/.
export const openContractSchema = z.object({
  contract_id: z.number(),
  contract_type: z.string(),
  currency: z.string(),
  underlying_symbol: z.string().optional(),
  buy_price: z.union([z.number(), z.string()]).optional(),
  bid_price: z.union([z.number(), z.string()]).optional(),
  payout: z.union([z.number(), z.string()]).optional(),
  profit: z.union([z.number(), z.string()]).optional(),
  current_spot: z.union([z.number(), z.string()]).optional(),
  entry_spot: z.union([z.number(), z.string()]).optional(),
  exit_spot: z.union([z.number(), z.string()]).optional(),
  exit_spot_time: z.number().optional(),
  purchase_time: z.number().optional(),
  date_expiry: z.number().optional(),
  is_sold: z.union([z.literal(0), z.literal(1)]).optional(),
  is_valid_to_sell: z.union([z.literal(0), z.literal(1)]).optional(),
  is_expired: z.union([z.literal(0), z.literal(1)]).optional(),
  status: z.string().optional(),
  longcode: z.string().optional(),
});
export type OpenContract = z.infer<typeof openContractSchema>;

export const openContractPushSchema = z.object({
  msg_type: z.literal("proposal_open_contract"),
  proposal_open_contract: openContractSchema,
  subscription: z.object({ id: z.string() }).optional(),
});

export const balanceSchema = z.object({
  balance: z.number(),
  currency: z.string(),
  loginid: z.string().optional(),
});
export type Balance = z.infer<typeof balanceSchema>;

export const balancePushSchema = z.object({
  msg_type: z.literal("balance"),
  balance: balanceSchema,
  subscription: z.object({ id: z.string() }).optional(),
});

export const buyResponseSchema = z.object({
  msg_type: z.literal("buy"),
  buy: z.object({
    contract_id: z.number(),
    transaction_id: z.number(),
    purchase_time: z.number(),
    buy_price: z.union([z.number(), z.string()]),
    payout: z.union([z.number(), z.string()]).optional(),
    longcode: z.string().optional(),
    shortcode: z.string().optional(),
    balance_after: z.union([z.number(), z.string()]).optional(),
  }),
});
export type BuyResult = z.infer<typeof buyResponseSchema>["buy"];

export const sellResponseSchema = z.object({
  msg_type: z.literal("sell"),
  sell: z.object({
    contract_id: z.number(),
    transaction_id: z.number(),
    sold_for: z.union([z.number(), z.string()]),
    balance_after: z.union([z.number(), z.string()]).optional(),
  }),
});
export type SellResult = z.infer<typeof sellResponseSchema>["sell"];

export const profitTableEntrySchema = z.object({
  // Deriv's profit_table schema documents contract_id and sell_time as nullable.
  contract_id: z.number().nullable(),
  transaction_id: z.number(),
  purchase_time: z.number(),
  sell_time: z.number().nullable().optional(),
  buy_price: z.union([z.number(), z.string()]),
  sell_price: z.union([z.number(), z.string()]).optional(),
  payout: z.union([z.number(), z.string()]).optional(),
  // underlying_symbol / contract_type / longcode are only present when the request set
  // `description: 1` (per Deriv's profit_table response schema).
  underlying_symbol: z.string().optional(),
  contract_type: z.string().optional(),
  longcode: z.string().optional(),
  app_id: z.union([z.number(), z.string()]).optional(),
});
export type ProfitTableEntry = z.infer<typeof profitTableEntrySchema>;

export const profitTableResponseSchema = z.object({
  msg_type: z.literal("profit_table"),
  profit_table: z.object({
    transactions: z.array(profitTableEntrySchema),
    count: z.number().optional(),
  }),
});

// ---------------------------------------------------------------------------
// Our own REST request validation (never Deriv's shape — these are what the
// trade ticket / portfolio UI actually sends us).
// ---------------------------------------------------------------------------

// NOTE: no `currency` field here on purpose. A proposal quote must always be priced in the
// session's actively selected Deriv account's own currency — never something the client
// claims — so the controller fills it in from that account row, not from this body.
export const proposalBodySchema = z.object({
  contractType: contractTypeSchema,
  symbol: z.string().min(2).max(30),
  amount: z.number().positive().optional(),
  basis: z.enum(["payout", "stake"]).optional(),
  duration: z.number().int().positive().optional(),
  durationUnit: z.enum(["d", "m", "s", "h", "t"]).optional(),
  barrier: z.string().optional(),
  barrier2: z.string().optional(),
  multiplier: z.number().positive().optional(),
});
export type ProposalBody = z.infer<typeof proposalBodySchema>;

export const buyRequestSchema = z.object({
  proposalId: z.string().min(1),
  priceAgreed: z.number().positive(),
  // Deriv's `buy` response never echoes contract_type/underlying_symbol back (verified at
  // developers.deriv.com/comparison/buy/), so these ride along from the proposal step the
  // client already completed — purely descriptive metadata for OUR local trade cache. The
  // financial truth (contract_id, transaction_id, buy_price, payout) always comes from
  // Deriv's own buy response, never from this body.
  contractType: contractTypeSchema,
  underlyingSymbol: z.string().min(1).max(30),
  confirmReal: z.boolean().optional(),
});
export type BuyRequestBody = z.infer<typeof buyRequestSchema>;

export const sellRequestSchema = z.object({
  contractId: z.number().int().positive(),
  minPrice: z.number().min(0).default(0),
});
export type SellRequestBody = z.infer<typeof sellRequestSchema>;

export const profitTableQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
});
