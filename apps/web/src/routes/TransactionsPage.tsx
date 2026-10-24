import { useEffect, useState } from "react";
import type { ProfitTableEntry } from "@derivdesk/shared-types";
import { api, ApiError } from "../lib/api";

function formatEpoch(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString();
}

export function TransactionsPage() {
  const [transactions, setTransactions] = useState<ProfitTableEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .tradeHistory(100)
      .then(setTransactions)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your trade history"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="card">
      <h1 style={{ marginTop: 0, fontSize: 18 }}>Transactions</h1>
      {error && <div className="error-text">{error}</div>}

      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : transactions.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>No closed trades on this account yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12 }}>
              <th style={{ padding: "6px 0" }}>Contract</th>
              <th>Opened</th>
              <th>Buy price</th>
              <th>Sell price</th>
              <th>P/L</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((t) => {
              const buyPrice = Number(t.buy_price);
              const sellPrice = t.sell_price !== undefined ? Number(t.sell_price) : null;
              const pnl = sellPrice !== null ? sellPrice - buyPrice : null;
              return (
                <tr key={t.transaction_id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px 0" }}>
                    <div>{t.underlying_symbol ?? "—"}</div>
                    {t.longcode && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{t.longcode}</div>}
                  </td>
                  <td style={{ color: "var(--text-muted)", fontSize: 13 }}>{formatEpoch(t.purchase_time)}</td>
                  <td className="numeric">{buyPrice.toFixed(2)}</td>
                  <td className="numeric">{sellPrice !== null ? sellPrice.toFixed(2) : "—"}</td>
                  <td className="numeric" style={{ color: pnl == null ? "var(--text-muted)" : pnl >= 0 ? "var(--positive)" : "var(--negative)" }}>
                    {pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 16, marginBottom: 0 }}>
        Sourced from Deriv's own trade statement (<code>profit_table</code>) — this is historical record, not a projection of future
        performance.
      </p>
    </div>
  );
}
