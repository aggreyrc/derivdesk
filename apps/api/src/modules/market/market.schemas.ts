import { z } from "zod";

// Field names verified against developers.deriv.com/comparison/active-symbols/ — the current
// API renamed `symbol`→`underlying_symbol` etc. from the legacy shape; do not "helpfully"
// rename these back, old tutorials/GitHub examples almost all still show the legacy names.
export const activeSymbolSchema = z.object({
  underlying_symbol: z.string(),
  underlying_symbol_name: z.string().optional(),
  underlying_symbol_type: z.string().optional(),
  market: z.string(),
  submarket: z.string().optional(),
  subgroup: z.string().optional(),
  pip_size: z.number().optional(),
  exchange_is_open: z.union([z.literal(0), z.literal(1)]).optional(),
  is_trading_suspended: z.union([z.literal(0), z.literal(1)]).optional(),
});
export type ActiveSymbol = z.infer<typeof activeSymbolSchema>;

export const activeSymbolsResponseSchema = z.object({
  msg_type: z.literal("active_symbols"),
  active_symbols: z.array(activeSymbolSchema),
});

// tick.epoch/quote/symbol are REQUIRED in the current API (they were optional in legacy) —
// verified at developers.deriv.com/comparison/ticks/. pip_size is now optional.
export const tickSchema = z.object({
  symbol: z.string(),
  quote: z.number(),
  epoch: z.number(),
  bid: z.number().optional(),
  ask: z.number().optional(),
  pip_size: z.number().optional(),
  id: z.string().optional(),
});
export type DerivTick = z.infer<typeof tickSchema>;

export const tickPushSchema = z.object({
  msg_type: z.literal("tick"),
  tick: tickSchema,
  subscription: z.object({ id: z.string() }).optional(),
});

export const candleSchema = z.object({
  epoch: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
});
export type Candle = z.infer<typeof candleSchema>;

export const candlesResponseSchema = z.object({
  msg_type: z.literal("candles"),
  candles: z.array(candleSchema),
  pip_size: z.number().optional(),
});

export const symbolsQuerySchema = z.object({
  contractType: z.string().optional(), // comma-separated; validated against Deriv's own enum server-side by Deriv itself
});

export const candlesQuerySchema = z.object({
  symbol: z.string().min(1),
  granularity: z.coerce.number().int().positive().default(60),
  count: z.coerce.number().int().positive().max(5000).default(200),
});

export const watchlistAddSchema = z.object({ symbol: z.string().min(1).max(30) });

// ---------------------------------------------------------------------------
// Trading-adjacent but NO-AUTH endpoints. Verified: `auth_required: 0` at
// developers.deriv.com/schemas/proposal_request.schema.json, and the "No Auth" badge at
// developers.deriv.com/comparison/contracts-for/. These stay in the market module (not
// trading/) because, unlike buy/sell/portfolio, they need no authenticated Deriv
// connection at all — they're reachable over the same pooled public client as ticks.
// ---------------------------------------------------------------------------

export const CONTRACT_TYPES = [
  "CALL", "PUT", "HIGHER", "LOWER", "ONETOUCH", "NOTOUCH", "MULTUP", "MULTDOWN",
  "DIGITMATCH", "DIGITDIFF", "DIGITOVER", "DIGITUNDER", "DIGITODD", "DIGITEVEN",
  "ASIAND", "ASIANU", "EXPIRYRANGE", "EXPIRYRANGEE", "EXPIRYMISS", "EXPIRYMISSE",
  "RANGE", "UPORDOWN", "TICKHIGH", "TICKLOW", "RESETCALL", "RESETPUT", "RUNHIGH",
  "RUNLOW", "ACCU", "CALLE", "PUTE", "VANILLALONGCALL", "VANILLALONGPUT",
  "TURBOSLONG", "TURBOSSHORT",
] as const;
export const contractTypeSchema = z.enum(CONTRACT_TYPES);
export type ContractType = z.infer<typeof contractTypeSchema>;

// What Deriv actually supports for a given underlying — the trade ticket must build its
// offered contract types/params from THIS, never from a hardcoded list, so the frontend
// can never construct a proposal Deriv would reject as unsupported.
export const contractForSchema = z.object({
  contract_type: contractTypeSchema,
  contract_category: z.string(),
  underlying_symbol: z.string(),
  market: z.string(),
  submarket: z.string().optional(),
  expiry_type: z.string().optional(),
  sentiment: z.string().optional(),
  barriers: z.number().optional(),
  min_contract_duration: z.string().optional(),
  max_contract_duration: z.string().optional(),
});
export type ContractFor = z.infer<typeof contractForSchema>;

export const contractsForResponseSchema = z.object({
  msg_type: z.literal("contracts_for"),
  contracts_for: z.object({
    available: z.array(contractForSchema),
    hit_count: z.number().optional(),
  }),
});

const limitOrderSchema = z
  .object({ stop_loss: z.number().optional(), take_profit: z.number().optional() })
  .optional();

export const proposalRequestSchema = z.object({
  contract_type: contractTypeSchema,
  underlying_symbol: z.string().min(2).max(30),
  currency: z.string().min(2).max(20),
  amount: z.number().positive().optional(),
  basis: z.enum(["payout", "stake"]).optional(),
  duration: z.number().int().positive().optional(),
  duration_unit: z.enum(["d", "m", "s", "h", "t"]).optional(),
  barrier: z.string().optional(),
  barrier2: z.string().optional(),
  multiplier: z.number().positive().optional(),
  growth_rate: z.number().optional(),
  cancellation: z.string().optional(),
  limit_order: limitOrderSchema,
});
export type ProposalRequest = z.infer<typeof proposalRequestSchema>;

// Only `id` is guaranteed present on a proposal response — verified at
// developers.deriv.com/comparison/proposal/. Every other field is advisory/display-only;
// the REAL price we pay is whatever `buy` itself confirms, not anything read off this.
export const proposalResponseSchema = z.object({
  msg_type: z.literal("proposal"),
  proposal: z.object({
    id: z.string(),
    ask_price: z.union([z.number(), z.string()]).optional(),
    payout: z.union([z.number(), z.string()]).optional(),
    spot: z.number().optional(),
    spot_time: z.number().optional(),
    display_value: z.string().optional(),
    longcode: z.string().optional(),
  }),
});
export type Proposal = z.infer<typeof proposalResponseSchema>["proposal"];

export const contractsForQuerySchema = z.object({ symbol: z.string().min(1) });
