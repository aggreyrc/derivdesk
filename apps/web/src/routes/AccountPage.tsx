import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { DerivConnectionState } from "@derivdesk/shared-types";
import { api, ApiError } from "../lib/api";
import { deriveErrorMessage } from "../lib/signIn";

export function AccountPage() {
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState<DerivConnectionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.derivAccounts());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your Deriv connection");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const derivError = params.get("deriv_error");
    if (derivError) setError(deriveErrorMessage(derivError));
    if (derivError || params.get("deriv")) setParams({}, { replace: true });
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.derivConnect();
      // Defence in depth: only ever navigate to an https URL, never a javascript:/data: one,
      // whatever the response contained.
      if (new URL(url).protocol !== "https:") throw new Error("Unexpected authorization URL");
      window.location.assign(url); // full navigation, deliberately — this is an OAuth redirect, not a fetch
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the Deriv connection");
      setBusy(false);
    }
  }

  async function handleRefresh() {
    setBusy(true);
    setError(null);
    try {
      setState(await api.derivRefresh());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not refresh your accounts");
    } finally {
      setBusy(false);
    }
  }

  async function handleActivate(accountId: string, isReal: boolean) {
    if (isReal && !window.confirm("Switch to your REAL Deriv account? Trades placed here use real money.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setState(await api.derivActivate(accountId, isReal));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not switch accounts");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm("Disconnect your Deriv account from DerivDesk?")) return;
    setBusy(true);
    setError(null);
    try {
      await api.derivDisconnect();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not disconnect");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="card">
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h1 style={{ marginTop: 0, fontSize: 18 }}>Account</h1>
      {error && <div className="error-text">{error}</div>}

      {!state?.connected ? (
        <>
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
            Connect your Deriv account to trade and view your positions here. DerivDesk never sees your Deriv password, and never holds
            your funds — your money stays on Deriv at all times.
          </p>
          <button className="button" style={{ width: "auto", padding: "10px 20px" }} onClick={handleConnect} disabled={busy}>
            Connect Deriv account
          </button>
        </>
      ) : (
        <>
          {state.needsReauth && (
            <div className="error-text">Your Deriv connection has expired. Reconnect below to keep trading.</div>
          )}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, marginBottom: 16 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12 }}>
                <th style={{ padding: "6px 0" }}>Account</th>
                <th>Type</th>
                <th>Balance</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.accounts.map((a) => (
                <tr key={a.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="numeric" style={{ padding: "8px 0" }}>
                    {a.derivAccountId}
                  </td>
                  <td>
                    <span className={`badge badge--${a.accountType.toLowerCase()}`}>{a.accountType}</span>
                  </td>
                  <td className="numeric">
                    {a.cachedBalance ? `${Number(a.cachedBalance).toFixed(2)} ${a.currency}` : "—"}
                  </td>
                  <td style={{ color: "var(--text-muted)" }}>{a.status}</td>
                  <td>
                    {a.isActive ? (
                      <span style={{ color: "var(--positive)", fontSize: 13 }}>Active</span>
                    ) : (
                      a.status === "active" && (
                        <button
                          className="button"
                          style={{ width: "auto", padding: "5px 12px", fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text)" }}
                          onClick={() => handleActivate(a.id, a.accountType === "REAL")}
                          disabled={busy}
                        >
                          Switch to this account
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              className="button"
              style={{ width: "auto", padding: "8px 16px", background: "transparent", border: "1px solid var(--border)", color: "var(--text)" }}
              onClick={handleRefresh}
              disabled={busy}
            >
              Refresh from Deriv
            </button>
            {state.needsReauth ? (
              <button className="button" style={{ width: "auto", padding: "8px 16px" }} onClick={handleConnect} disabled={busy}>
                Reconnect
              </button>
            ) : (
              <button
                className="button"
                style={{ width: "auto", padding: "8px 16px", background: "transparent", border: "1px solid var(--negative)", color: "var(--negative)" }}
                onClick={handleDisconnect}
                disabled={busy}
              >
                Disconnect
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
