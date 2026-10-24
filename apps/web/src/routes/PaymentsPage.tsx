import { useCallback, useEffect, useState } from "react";
import type { PaymentAgentView, PaymentAgentWithdrawalSummary } from "@derivdesk/shared-types";
import { api, ApiError } from "../lib/api";
import { useDerivStatus } from "../lib/derivStatus";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function statusColor(status: PaymentAgentWithdrawalSummary["status"]): string {
  switch (status) {
    case "COMPLETE":
      return "var(--positive)";
    case "REJECTED":
    case "FAILED":
      return "var(--negative)";
    default:
      return "var(--text-muted)";
  }
}

function HistoryTable({ history, onRefreshRow }: { history: PaymentAgentWithdrawalSummary[]; onRefreshRow: (requestId: string) => void }) {
  if (history.length === 0) {
    return <p style={{ color: "var(--text-muted)", fontSize: 14 }}>No withdrawal requests yet.</p>;
  }
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
      <thead>
        <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12 }}>
          <th style={{ padding: "6px 0" }}>Requested</th>
          <th>Amount</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {history.map((w) => (
          <tr key={w.id} style={{ borderTop: "1px solid var(--border)" }}>
            <td style={{ padding: "8px 0", color: "var(--text-muted)", fontSize: 13 }}>{formatDate(w.createdAt)}</td>
            <td className="numeric">
              {w.amount} {w.currency}
            </td>
            <td style={{ color: statusColor(w.status) }}>{w.status}</td>
            <td>
              {(w.status === "REQUESTED" || w.status === "PENDING") && (
                <button
                  className="button"
                  style={{ width: "auto", padding: "4px 10px", fontSize: 12, background: "transparent", border: "1px solid var(--border)", color: "var(--text)" }}
                  onClick={() => onRefreshRow(w.requestId)}
                >
                  Refresh
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PaymentsPage() {
  const derivStatus = useDerivStatus();
  const activeAccount = derivStatus?.accounts.find((a) => a.isActive);
  const canWithdraw = activeAccount?.accountType === "REAL";

  const [depositUrl, setDepositUrl] = useState<string | null>(null);
  const [agents, setAgents] = useState<PaymentAgentView[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [history, setHistory] = useState<PaymentAgentWithdrawalSummary[]>([]);

  const [step, setStep] = useState<"form" | "verify">("form");
  const [agentId, setAgentId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [code, setCode] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [otpInfo, setOtpInfo] = useState<{ expiresAt: number; nextRequestAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadHistory = useCallback(() => {
    api.withdrawalHistory().then(setHistory).catch(() => undefined);
  }, []);

  useEffect(() => {
    api.depositLink().then((r) => setDepositUrl(r.url)).catch(() => undefined);
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!canWithdraw) {
      setAgents(null);
      return;
    }
    api
      .paymentAgents()
      .then(setAgents)
      .catch((err) => setAgentsError(err instanceof ApiError ? err.message : "Could not load payment agents"));
  }, [canWithdraw]);

  function resetFlow() {
    setStep("form");
    setAgentId("");
    setAmount("");
    setCode("");
    setNotes("");
    setOtpInfo(null);
    setError(null);
  }

  async function handleRequestCode() {
    setError(null);
    const parsedAgentId = Number(agentId);
    const parsedAmount = Number(amount);
    if (!parsedAgentId || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError("Choose a payment agent and enter an amount greater than 0.");
      return;
    }
    setBusy(true);
    try {
      const otp = await api.requestWithdrawalOtp(parsedAgentId, parsedAmount);
      setOtpInfo(otp);
      setStep("verify");
      setNotice("Deriv sent a verification code directly to you — check your Deriv app or email, not here.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not request a verification code");
    } finally {
      setBusy(false);
    }
  }

  async function handleWithdraw() {
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the 6-digit verification code Deriv sent you.");
      return;
    }
    if (!window.confirm(`Withdraw ${amount} ${activeAccount?.currency ?? ""} from your REAL account? This moves real money and can't be undone from here.`)) {
      return;
    }
    setBusy(true);
    try {
      await api.withdraw({ agentId: Number(agentId), amount: Number(amount), verificationCode: code, notes: notes || undefined });
      setNotice("Withdrawal submitted to Deriv.");
      resetFlow();
      loadHistory();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit the withdrawal");
    } finally {
      setBusy(false);
    }
  }

  async function handleRefreshRow(requestId: string) {
    try {
      await api.withdrawalStatus(requestId);
      loadHistory();
    } catch {
      // best-effort — the row just keeps its last known status
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 18 }}>Deposit</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          There's no deposit API on Deriv — every deposit happens on Deriv's own cashier, outside DerivDesk.
        </p>
        <a
          href={depositUrl ?? "#"}
          target="_blank"
          rel="noreferrer"
          className="button"
          style={{
            width: "auto",
            display: "inline-block",
            padding: "10px 20px",
            textDecoration: "none",
            opacity: depositUrl ? 1 : 0.6,
            pointerEvents: depositUrl ? "auto" : "none",
          }}
        >
          Open Deriv cashier to deposit
        </a>
      </div>

      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 18 }}>Withdraw</h1>
        {!canWithdraw ? (
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
            Withdrawals need your REAL Deriv account active — Deriv's payment-agent network doesn't operate on demo balances. Switch
            accounts on the <a href="/account">Account</a> page.
          </p>
        ) : (
          <>
            {error && <div className="error-text">{error}</div>}
            {notice && !error && (
              <p style={{ color: "var(--accent)", fontSize: 13, marginTop: 0 }}>{notice}</p>
            )}
            {agentsError && <div className="error-text">{agentsError}</div>}

            {step === "form" && (
              <>
                <div className="field">
                  <label>Payment agent</label>
                  <select
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "9px 10px", color: "var(--text)" }}
                  >
                    <option value="">{agents === null ? "Loading…" : "Select an agent"}</option>
                    {agents?.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name ?? a.nickname ?? `Agent #${a.id}`}
                        {a.withdrawal_minimum || a.withdrawal_maximum
                          ? ` (${a.withdrawal_minimum ?? "?"}–${a.withdrawal_maximum ?? "?"} ${activeAccount?.currency ?? ""})`
                          : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Amount ({activeAccount?.currency})</label>
                  <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </div>
                <button className="button" style={{ width: "auto", padding: "10px 20px" }} onClick={handleRequestCode} disabled={busy}>
                  Send verification code
                </button>
              </>
            )}

            {step === "verify" && (
              <>
                <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
                  Withdrawing {amount} {activeAccount?.currency} via agent #{agentId}
                  {otpInfo && ` — code expires ${formatDate(new Date(otpInfo.expiresAt * 1000).toISOString())}`}.
                </p>
                <div className="field">
                  <label>Verification code</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="6-digit code"
                  />
                </div>
                <div className="field">
                  <label>Notes (optional)</label>
                  <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button className="button" style={{ width: "auto", padding: "10px 20px" }} onClick={handleWithdraw} disabled={busy}>
                    Confirm withdrawal
                  </button>
                  <button
                    className="button"
                    style={{ width: "auto", padding: "10px 20px", background: "transparent", border: "1px solid var(--border)", color: "var(--text)" }}
                    onClick={resetFlow}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 18 }}>Withdrawal history</h1>
        <HistoryTable history={history} onRefreshRow={handleRefreshRow} />
      </div>
    </div>
  );
}
