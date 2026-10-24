// Hand-mirrored from packages/db/prisma/schema.prisma. Deliberately not
// generated from Prisma output, because Prisma's generated client pulls in
// its Node-only runtime — importing it from a browser bundle would either
// fail to build or ship things a frontend has no business shipping (schema
// internals, engine glue). Keep these two in sync by hand when the schema's
// enums change; it's a handful of lines, not worth a build step yet.

export type DerivAccountType = "DEMO" | "REAL";

export type TradeStatus = "OPEN" | "CLOSED" | "SOLD" | "CANCELLED";

export type WithdrawalStatus = "REQUESTED" | "PENDING" | "COMPLETE" | "REJECTED" | "FAILED";

export type UserStatus = "ACTIVE" | "SUSPENDED";

/** One Deriv account as the client app sees it. Balance is a CACHED value (see cachedBalanceAt);
 *  live balance arrives over the WebSocket gateway from Phase 4/5 on. */
export interface DerivAccountView {
  id: string; // our row id — what the activate endpoint takes (never Deriv's loginid)
  derivAccountId: string;
  accountType: DerivAccountType;
  currency: string;
  group: string;
  status: string;
  nickname: string | null;
  cachedBalance: string | null; // Decimal serializes as a string over JSON
  cachedBalanceAt: string | null;
  isActive: boolean;
}

export interface DerivConnectionState {
  connected: boolean;
  needsReauth: boolean;
  accounts: DerivAccountView[];
  activeAccountId: string | null;
}

export interface PaymentAgentWithdrawalSummary {
  id: string;
  derivAccountId: string;
  agentId: string;
  amount: string;
  currency: string;
  requestId: string;
  status: WithdrawalStatus;
  createdAt: string;
  updatedAt: string;
}

/** A Deriv payment agent, as returned by GET /api/payments/agents. Everything but `id` is
 *  optional/nullable because Deriv itself documents these fields that way — an agent with an
 *  incomplete profile is still a valid agent to withdraw through. */
export interface PaymentAgentView {
  id: number;
  name?: string | null;
  nickname?: string | null;
  information?: string | null;
  countries?: string[] | null;
  payment_methods?: string[] | null;
  withdrawal_minimum?: string | null;
  withdrawal_maximum?: string | null;
  withdrawal_commission?: number | null;
}

export interface WithdrawalOtpResult {
  expiresAt: number;
  nextRequestAt: number;
}

// ---------------------------------------------------------------------------
// Trading (Phase 5) — hand-mirrored from apps/api's trading.schemas.ts /
// market.schemas.ts, for the same reason as above (no Node-only Prisma/zod
// runtime in a browser bundle). Numeric fields Deriv itself documents as
// `string | number` stay a union here too — never silently narrowed to
// `number` on the way into the UI.
// ---------------------------------------------------------------------------

export type ContractType =
  | "CALL" | "PUT" | "HIGHER" | "LOWER" | "ONETOUCH" | "NOTOUCH" | "MULTUP" | "MULTDOWN"
  | "DIGITMATCH" | "DIGITDIFF" | "DIGITOVER" | "DIGITUNDER" | "DIGITODD" | "DIGITEVEN"
  | "ASIAND" | "ASIANU" | "EXPIRYRANGE" | "EXPIRYRANGEE" | "EXPIRYMISS" | "EXPIRYMISSE"
  | "RANGE" | "UPORDOWN" | "TICKHIGH" | "TICKLOW" | "RESETCALL" | "RESETPUT" | "RUNHIGH"
  | "RUNLOW" | "ACCU" | "CALLE" | "PUTE" | "VANILLALONGCALL" | "VANILLALONGPUT"
  | "TURBOSLONG" | "TURBOSSHORT";

/** What Deriv actually supports for a symbol — the trade ticket builds its contract-type
 *  options from a list of these, never from a hardcoded list of its own. */
export interface ContractFor {
  contract_type: ContractType;
  contract_category: string;
  underlying_symbol: string;
  market: string;
  submarket?: string;
  expiry_type?: string;
  sentiment?: string;
  barriers?: number;
  min_contract_duration?: string;
  max_contract_duration?: string;
}

/** A price quote. Only `id` is guaranteed — see apps/api's comment on proposalResponseSchema. */
export interface Proposal {
  id: string;
  ask_price?: number | string;
  payout?: number | string;
  spot?: number;
  spot_time?: number;
  display_value?: string;
  longcode?: string;
}

export interface BuyResult {
  contract_id: number;
  transaction_id: number;
  purchase_time: number;
  buy_price: number | string;
  payout?: number | string;
  longcode?: string;
  shortcode?: string;
  balance_after?: number | string;
}

export interface SellResult {
  contract_id: number;
  transaction_id: number;
  sold_for: number | string;
  balance_after?: number | string;
}

export interface PortfolioContract {
  contract_id: number;
  contract_type: string;
  underlying_symbol: string;
  buy_price: number | string;
  payout?: number | string;
  purchase_time: number;
  date_expiry?: number;
  longcode?: string;
}

/** A contract's live state, as pushed over the WS gateway's POSITION_UPDATED event, or
 *  returned by GET /api/trading/portfolio for a single contract. Only contract_id,
 *  contract_type and currency are guaranteed — everything else is advisory/display-only. */
export interface OpenContract {
  contract_id: number;
  contract_type: string;
  currency: string;
  underlying_symbol?: string;
  buy_price?: number | string;
  bid_price?: number | string;
  payout?: number | string;
  profit?: number | string;
  current_spot?: number | string;
  entry_spot?: number | string;
  exit_spot?: number | string;
  exit_spot_time?: number;
  purchase_time?: number;
  date_expiry?: number;
  is_sold?: 0 | 1;
  is_valid_to_sell?: 0 | 1;
  is_expired?: 0 | 1;
  status?: string;
  longcode?: string;
}

export interface ProfitTableEntry {
  contract_id: number | null;
  transaction_id: number;
  purchase_time: number;
  sell_time?: number | null;
  buy_price: number | string;
  sell_price?: number | string;
  payout?: number | string;
  underlying_symbol?: string;
  contract_type?: string;
  longcode?: string;
}
