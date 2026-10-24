import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@derivdesk/db";
import { getWithdrawalStatus, listAgents, requestWithdrawalOtp, withdraw } from "./payments.service.js";
import { DerivApiError, type DerivClientLike } from "../deriv/deriv.client.js";

// payments.service.ts calls getValidAccessToken (already tested in deriv.service.test.ts) —
// stub it here so these tests focus on payments behavior, not token-refresh behavior.
vi.mock("../deriv/deriv.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../deriv/deriv.service.js")>();
  return { ...actual, getValidAccessToken: vi.fn().mockResolvedValue("access_token_abc") };
});

function fakeAudit() {
  return vi.fn().mockResolvedValue(undefined);
}

const realAccount = { id: "acc_1", userId: "user_1", accountType: "REAL", currency: "USD", status: "active", derivAccountId: "CR1" };
const demoAccount = { id: "acc_demo", userId: "user_1", accountType: "DEMO", currency: "USD", status: "active", derivAccountId: "VRTC1" };

function fakeDb(overrides: Record<string, Record<string, unknown>> = {}) {
  return {
    session: { findFirst: vi.fn().mockResolvedValue({ id: "sess_1", userId: "user_1", activeDerivAccount: realAccount }), ...overrides.session },
    paymentAgentWithdrawal: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      ...overrides.paymentAgentWithdrawal,
    },
  } as unknown as PrismaClient;
}

const settings = { clientId: "app_1", scopes: "trade payment" };
const actor = { userId: "user_1", label: "CR1000001" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listAgents / requestWithdrawalOtp / withdraw — real-account-only gate", () => {
  it("refuses to list payment agents for a demo account", async () => {
    const db = fakeDb({ session: { findFirst: vi.fn().mockResolvedValue({ id: "sess_1", userId: "user_1", activeDerivAccount: demoAccount }) } });
    const client = { listPaymentAgents: vi.fn() } as unknown as DerivClientLike;

    await expect(listAgents({ db, client, audit: fakeAudit(), settings }, "user_1", "sess_1")).rejects.toMatchObject({ status: 409, code: "RealAccountRequired" });
    expect(client.listPaymentAgents).not.toHaveBeenCalled();
  });

  it("passes the active account's own currency, never a client-supplied one", async () => {
    const db = fakeDb();
    const client = { listPaymentAgents: vi.fn().mockResolvedValue([{ id: 1 }]) } as unknown as DerivClientLike;

    const agents = await listAgents({ db, client, audit: fakeAudit(), settings }, "user_1", "sess_1");

    expect(client.listPaymentAgents).toHaveBeenCalledWith("access_token_abc", "USD", undefined);
    expect(agents).toEqual([{ id: 1 }]);
  });
});

describe("requestWithdrawalOtp", () => {
  it("requests a verification code for the agent/amount and audits it", async () => {
    const db = fakeDb();
    const audit = fakeAudit();
    const client = { requestWithdrawalOtp: vi.fn().mockResolvedValue({ expires_at: 100, next_request_at: 60 }) } as unknown as DerivClientLike;

    const result = await requestWithdrawalOtp({ db, client, audit, settings }, actor, "sess_1", { agentId: 42, amount: 10 });

    expect(client.requestWithdrawalOtp).toHaveBeenCalledWith("access_token_abc", { agentId: 42, amount: "10.00", currency: "USD" });
    expect(result).toEqual({ expiresAt: 100, nextRequestAt: 60 });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "payments.withdrawal_otp_requested" }));
  });
});

describe("withdraw", () => {
  it("writes a REQUESTED row before calling Deriv, then updates it to Deriv's own returned status", async () => {
    const db = fakeDb();
    const audit = fakeAudit();
    const client = {
      withdrawViaPaymentAgent: vi.fn().mockResolvedValue({ status: "pending", transaction_id: 999 }),
    } as unknown as DerivClientLike;

    await withdraw({ db, client, audit, settings }, actor, "sess_1", { agentId: 42, amount: 10, verificationCode: "123456" });

    expect(db.paymentAgentWithdrawal.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REQUESTED", amount: "10.00", currency: "USD", agentId: "42" }) }),
    );
    expect(db.paymentAgentWithdrawal.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "PENDING" } }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "payments.withdrawal_submitted" }));
  });

  it("deletes the local row and surfaces Deriv's own rejection reason when the withdrawal fails", async () => {
    const db = fakeDb();
    const audit = fakeAudit();
    const client = {
      withdrawViaPaymentAgent: vi.fn().mockRejectedValue(new DerivApiError(400, "InvalidVerificationCode", "bad code")),
    } as unknown as DerivClientLike;

    await expect(withdraw({ db, client, audit, settings }, actor, "sess_1", { agentId: 42, amount: 10, verificationCode: "000000" })).rejects.toMatchObject({
      status: 422,
      code: "InvalidVerificationCode",
    });

    expect(db.paymentAgentWithdrawal.delete).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "payments.withdrawal_failed" }));
  });

  it.each([
    ["a timeout / unreachable Deriv", new DerivApiError(504, "Unreachable", "Could not reach Deriv")],
    ["a Deriv 5xx", new DerivApiError(503, "ServiceUnavailable", "down")],
    ["a 2xx Deriv response we could not parse", new DerivApiError(502, "UnexpectedResponse", "bad shape")],
    ["a non-Deriv error", new Error("socket hang up")],
  ])("KEEPS the REQUESTED row and says the outcome is unknown after %s (Deriv may have accepted it)", async (_label, failure) => {
    const db = fakeDb();
    const audit = fakeAudit();
    const client = { withdrawViaPaymentAgent: vi.fn().mockRejectedValue(failure) } as unknown as DerivClientLike;

    await expect(withdraw({ db, client, audit, settings }, actor, "sess_1", { agentId: 42, amount: 10, verificationCode: "123456" })).rejects.toMatchObject({
      status: 502,
      code: "WithdrawalOutcomeUnknown",
    });

    expect(db.paymentAgentWithdrawal.delete).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "payments.withdrawal_outcome_unknown" }));
  });

  it("does not report a failure (nor delete the row) when only the audit write fails after Deriv accepted the withdrawal", async () => {
    const db = fakeDb({ paymentAgentWithdrawal: { update: vi.fn().mockResolvedValue({ id: "w1", status: "PENDING" }) } });
    const audit = vi.fn().mockRejectedValue(new Error("audit table unavailable"));
    const client = { withdrawViaPaymentAgent: vi.fn().mockResolvedValue({ status: "pending", transaction_id: 1 }) } as unknown as DerivClientLike;

    await expect(withdraw({ db, client, audit, settings }, actor, "sess_1", { agentId: 42, amount: 10, verificationCode: "123456" })).resolves.toMatchObject({
      id: "w1",
    });
    expect(db.paymentAgentWithdrawal.delete).not.toHaveBeenCalled();
  });

  it("refuses to withdraw from a demo account", async () => {
    const db = fakeDb({ session: { findFirst: vi.fn().mockResolvedValue({ id: "sess_1", userId: "user_1", activeDerivAccount: demoAccount }) } });
    const client = { withdrawViaPaymentAgent: vi.fn() } as unknown as DerivClientLike;

    await expect(withdraw({ db, client, audit: fakeAudit(), settings }, actor, "sess_1", { agentId: 1, amount: 5, verificationCode: "123456" })).rejects.toMatchObject({
      status: 409,
      code: "RealAccountRequired",
    });
    expect(client.withdrawViaPaymentAgent).not.toHaveBeenCalled();
  });
});

describe("getWithdrawalStatus", () => {
  it("refuses a request_id that doesn't belong to this user (IDOR)", async () => {
    const db = fakeDb({ paymentAgentWithdrawal: { findFirst: vi.fn().mockResolvedValue(null) } });
    const client = {} as unknown as DerivClientLike;

    await expect(getWithdrawalStatus({ db, client, audit: fakeAudit(), settings }, "user_1", "req_someone_else")).rejects.toMatchObject({ status: 404 });
  });

  it("does not re-poll Deriv once a withdrawal has already settled", async () => {
    const db = fakeDb({ paymentAgentWithdrawal: { findFirst: vi.fn().mockResolvedValue({ requestId: "req_1", status: "COMPLETE" }) } });
    const client = { getWithdrawalStatus: vi.fn() } as unknown as DerivClientLike;

    const result = await getWithdrawalStatus({ db, client, audit: fakeAudit(), settings }, "user_1", "req_1");

    expect(client.getWithdrawalStatus).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "COMPLETE" });
  });

  it("refreshes an unsettled withdrawal's status from Deriv", async () => {
    const db = fakeDb({
      paymentAgentWithdrawal: {
        findFirst: vi.fn().mockResolvedValue({ requestId: "req_1", status: "PENDING" }),
        update: vi.fn().mockResolvedValue({ requestId: "req_1", status: "COMPLETE" }),
      },
    });
    const client = { getWithdrawalStatus: vi.fn().mockResolvedValue({ status: "complete", transaction_id: 1 }) } as unknown as DerivClientLike;

    const result = await getWithdrawalStatus({ db, client, audit: fakeAudit(), settings }, "user_1", "req_1");

    expect(db.paymentAgentWithdrawal.update).toHaveBeenCalledWith({ where: { requestId: "req_1" }, data: { status: "COMPLETE" } });
    expect(result).toMatchObject({ status: "COMPLETE" });
  });
});
