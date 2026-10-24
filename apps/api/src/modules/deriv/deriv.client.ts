import { z } from "zod";
import type { DerivOAuthSettings } from "../../lib/config.js";
import { codeChallengeS256 } from "../../lib/pkce.js";

// Thin adapter over Deriv's REST API + OAuth endpoints (verified against
// developers.deriv.com — see docs/deriv-integration.md). Nothing else in the
// codebase talks to Deriv over HTTP. Two rules enforced here:
//   1. No token ever appears in an error message or log line.
//   2. Every response is parsed strictly; an unexpected shape is an error,
//      never silently coerced into "probably fine".

export class DerivApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive().optional(),
  scope: z.string().optional(),
});
export type DerivTokenResponse = z.infer<typeof tokenResponseSchema>;

const accountSchema = z.object({
  account_id: z.string().min(1),
  balance: z.coerce.number(),
  currency: z.string().min(1),
  group: z.string().min(1),
  status: z.string().min(1),
  account_type: z.enum(["demo", "real"]),
});
export type DerivAccountRecord = z.infer<typeof accountSchema>;

const otpResponseSchema = z.object({ data: z.object({ url: z.string().url() }) });

// ---------------------------------------------------------------------------
// Payment agents (Phase 6) — a separate REST surface from the `/trading/v1/options/*`
// endpoints above: base path `/payment-agents/v1/`, same `{ data, errors, metadata }`
// envelope, but POST bodies are wrapped in their own `data` object (verified field-by-field
// against developers.deriv.com/schemas/payment_agent_withdraw_request.schema.json and
// .../payment_agent_withdraw_verification_request.schema.json — both show `data: {...}` as
// the top-level body shape, not flat fields). This is the ONLY API-reachable withdrawal
// path (see docs/phase1-architecture.md §2/§10) — there is no fiat deposit endpoint at all,
// and no direct bank/card withdrawal endpoint; both always happen outside this app, on
// Deriv's own cashier.
const paymentAgentSchema = z.object({
  id: z.number(),
  name: z.string().nullable().optional(),
  nickname: z.string().nullable().optional(),
  information: z.string().nullable().optional(),
  countries: z.array(z.string()).nullable().optional(),
  payment_methods: z.array(z.string()).nullable().optional(),
  withdrawal_minimum: z.string().nullable().optional(),
  withdrawal_maximum: z.string().nullable().optional(),
  withdrawal_commission: z.number().nullable().optional(),
});
export type DerivPaymentAgent = z.infer<typeof paymentAgentSchema>;
const paymentAgentListSchema = z.object({ data: z.array(paymentAgentSchema) });

const withdrawVerificationSchema = z.object({ data: z.object({ expires_at: z.number(), next_request_at: z.number() }) });
export type WithdrawalOtp = z.infer<typeof withdrawVerificationSchema>["data"];

const withdrawalStatusSchema = z.enum(["requested", "pending", "complete", "rejected", "failed"]);
export type DerivWithdrawalStatus = z.infer<typeof withdrawalStatusSchema>;
const withdrawResultSchema = z.object({
  data: z.object({ status: withdrawalStatusSchema, transaction_id: z.number().nullable() }),
});
export type DerivWithdrawResult = z.infer<typeof withdrawResultSchema>["data"];

type FetchLike = typeof fetch;

/** Public surface used by the rest of the app — lets tests pass plain mock objects
 *  instead of real DerivClient instances (a class's private fields make it otherwise
 *  impossible to satisfy structurally). Production code always passes a real DerivClient. */
export interface DerivClientLike {
  buildAuthorizationUrl(params: { state: string; codeVerifier: string }): string;
  exchangeCode(params: { code: string; codeVerifier: string }): Promise<DerivTokenResponse>;
  refresh(refreshToken: string): Promise<DerivTokenResponse>;
  listAccounts(accessToken: string): Promise<DerivAccountRecord[]>;
  requestOtp(accessToken: string, derivAccountId: string): Promise<string>;
  listPaymentAgents(accessToken: string, currency: string, country?: string): Promise<DerivPaymentAgent[]>;
  requestWithdrawalOtp(accessToken: string, params: { agentId: number; amount: string; currency: string }): Promise<WithdrawalOtp>;
  withdrawViaPaymentAgent(
    accessToken: string,
    params: { agentId: number; amount: string; currency: string; verificationCode: string; requestId: string; notes?: string },
  ): Promise<DerivWithdrawResult>;
  getWithdrawalStatus(accessToken: string, requestId: string): Promise<DerivWithdrawResult>;
}

export class DerivClient implements DerivClientLike {
  constructor(
    private settings: DerivOAuthSettings,
    private fetchImpl: FetchLike = fetch,
    private timeoutMs = 10_000,
  ) {}

  buildAuthorizationUrl(params: { state: string; codeVerifier: string }): string {
    const url = new URL(this.settings.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.settings.clientId);
    url.searchParams.set("redirect_uri", this.settings.redirectUri);
    url.searchParams.set("scope", this.settings.scopes);
    url.searchParams.set("state", params.state);
    url.searchParams.set("code_challenge", codeChallengeS256(params.codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeCode(params: { code: string; codeVerifier: string }): Promise<DerivTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.settings.clientId,
      code: params.code,
      redirect_uri: this.settings.redirectUri,
      code_verifier: params.codeVerifier,
    });
    // Deriv's reference token call doesn't list a secret, but its workflow guide mentions one.
    // Send it only when configured, so either reading of the docs works.
    if (this.settings.clientSecret) {
      body.set("client_secret", this.settings.clientSecret);
    }
    return this.tokenRequest(body);
  }

  /**
   * Standard OAuth2 refresh grant. NOTE: Deriv's docs say a refresh_token is returned but
   * don't document this request; this follows RFC 6749 §6 and is unverified against a live
   * Deriv app. Failure is handled (the caller flags the connection for re-auth).
   */
  async refresh(refreshToken: string): Promise<DerivTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.settings.clientId,
      refresh_token: refreshToken,
    });
    if (this.settings.clientSecret) {
      body.set("client_secret", this.settings.clientSecret);
    }
    return this.tokenRequest(body);
  }

  async listAccounts(accessToken: string): Promise<DerivAccountRecord[]> {
    const json = await this.apiRequest("/trading/v1/options/accounts", accessToken);
    const raw = (json as { data?: unknown } | null)?.data;
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const parsed = z.array(accountSchema).safeParse(items);
    if (!parsed.success) {
      throw new DerivApiError(502, "UnexpectedResponse", "Deriv returned an account list in an unexpected shape");
    }
    return parsed.data;
  }

  /** Returns a one-time-password WebSocket URL. Used by the Phase 4 WS manager; the URL is a secret. */
  async requestOtp(accessToken: string, derivAccountId: string): Promise<string> {
    const json = await this.apiRequest(`/trading/v1/options/accounts/${encodeURIComponent(derivAccountId)}/otp`, accessToken, {
      method: "POST",
    });
    const parsed = otpResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new DerivApiError(502, "UnexpectedResponse", "Deriv returned an OTP response in an unexpected shape");
    }
    return parsed.data.data.url;
  }

  /** GET /payment-agents/v1/agents — verified at developers.deriv.com/schemas/payment_agent_list_response.schema.json.
   *  `currency` is required by Deriv (agent availability is currency-scoped); we always pass the
   *  active account's own currency, never one the client supplies directly (see payments.controller.ts). */
  async listPaymentAgents(accessToken: string, currency: string, country?: string): Promise<DerivPaymentAgent[]> {
    const query = new URLSearchParams({ currency });
    if (country) query.set("country", country);
    const json = await this.apiRequest(`/payment-agents/v1/agents?${query.toString()}`, accessToken);
    const parsed = paymentAgentListSchema.safeParse(json);
    if (!parsed.success) {
      throw new DerivApiError(502, "UnexpectedResponse", "Deriv returned a payment agent list in an unexpected shape");
    }
    return parsed.data.data;
  }

  /** POST /payment-agents/v1/withdraw/verification_code — must be called before withdrawViaPaymentAgent;
   *  the 6-digit code it triggers (sent by Deriv to the user directly, never through us) is required as
   *  `verification_code` on the withdraw call. Verified at
   *  developers.deriv.com/schemas/payment_agent_withdraw_verification_request.schema.json. */
  async requestWithdrawalOtp(accessToken: string, params: { agentId: number; amount: string; currency: string }): Promise<WithdrawalOtp> {
    const json = await this.apiRequest("/payment-agents/v1/withdraw/verification_code", accessToken, {
      method: "POST",
      body: { data: { agent_id: params.agentId, amount: params.amount, currency: params.currency } },
    });
    const parsed = withdrawVerificationSchema.safeParse(json);
    if (!parsed.success) {
      throw new DerivApiError(502, "UnexpectedResponse", "Deriv returned a verification-code response in an unexpected shape");
    }
    return parsed.data.data;
  }

  /** POST /payment-agents/v1/withdraw — verified at
   *  developers.deriv.com/schemas/payment_agent_withdraw_request.schema.json. `requestId` is OUR
   *  idempotency key (Deriv rejects a reused one with `RequestIDUsed`) — always generate a fresh one
   *  per attempt, never retry a failed submission with the same id. */
  async withdrawViaPaymentAgent(
    accessToken: string,
    params: { agentId: number; amount: string; currency: string; verificationCode: string; requestId: string; notes?: string },
  ): Promise<DerivWithdrawResult> {
    const json = await this.apiRequest("/payment-agents/v1/withdraw", accessToken, {
      method: "POST",
      body: {
        data: {
          agent_id: params.agentId,
          amount: params.amount,
          currency: params.currency,
          verification_code: params.verificationCode,
          request_id: params.requestId,
          ...(params.notes ? { notes: params.notes } : {}),
        },
      },
    });
    const parsed = withdrawResultSchema.safeParse(json);
    if (!parsed.success) {
      throw new DerivApiError(502, "UnexpectedResponse", "Deriv returned a withdrawal response in an unexpected shape");
    }
    return parsed.data.data;
  }

  /** GET /payment-agents/v1/withdraw/{request_id} — status polling, same response shape as the
   *  withdraw call itself (verified: both the withdraw and withdraw-status docs describe the same
   *  `requested|pending|complete|rejected|failed` status enum and `transaction_id`). */
  async getWithdrawalStatus(accessToken: string, requestId: string): Promise<DerivWithdrawResult> {
    const json = await this.apiRequest(`/payment-agents/v1/withdraw/${encodeURIComponent(requestId)}`, accessToken);
    const parsed = withdrawResultSchema.safeParse(json);
    if (!parsed.success) {
      throw new DerivApiError(502, "UnexpectedResponse", "Deriv returned a withdrawal-status response in an unexpected shape");
    }
    return parsed.data.data;
  }

  private async tokenRequest(body: URLSearchParams): Promise<DerivTokenResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.settings.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new DerivApiError(504, "Unreachable", "Could not reach Deriv's authorization server");
    }

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      // OAuth errors look like { error: "invalid_grant", error_description: "..." }.
      const code = typeof (json as { error?: unknown } | null)?.error === "string" ? (json as { error: string }).error : "TokenRequestFailed";
      throw new DerivApiError(res.status, code, "Deriv rejected the token request");
    }
    const parsed = tokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new DerivApiError(502, "UnexpectedResponse", "Deriv returned a token response in an unexpected shape");
    }
    return parsed.data;
  }

  private async apiRequest(path: string, accessToken: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.settings.apiBaseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          // Deriv's OpenAPI marks this header required on these calls even though the auth guide
          // says OAuth doesn't need it. The App ID equals the OAuth client_id, so always sending it is harmless.
          "Deriv-App-ID": this.settings.clientId,
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new DerivApiError(504, "Unreachable", "Could not reach Deriv");
    }

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      // Deriv error envelope (both the `/trading/v1/options/*` and `/payment-agents/v1/*`
      // surfaces use this shape): { errors: [{ status, code, message }], meta|metadata }
      const first = (json as { errors?: Array<{ code?: string }> } | null)?.errors?.[0];
      throw new DerivApiError(res.status, first?.code ?? "DerivRequestFailed", "Deriv rejected the request");
    }
    return json;
  }
}
