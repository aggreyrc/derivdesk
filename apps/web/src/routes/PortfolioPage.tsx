import { useCallback, useEffect, useState } from "react";
import type { PortfolioContract } from "@derivdesk/shared-types";
import { api, ApiError } from "../lib/api";
import { usePosition } from "../lib/usePosition";

const POLL_MS = 15_000; // belt-and-suspenders refresh of the full list; live P/L comes from the WS push below

function PositionRow({ position, onSold }: { position: PortfolioContract; onSold: () => void }) {
  const live = usePosition(position.contract_id);
  const [selling, setSelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The initial GET /portfolio snapshot never includes `profit` — it only arrives once the
  // WS position subscription's first push lands. Before that, we simply show no figure
  // rather than inventing one from buy_price/payout.
  const profit = live?.profit !== undefined ? Number(live.profit) : null;
  const canSell = live ? live.is_valid_to_sell !== 0 && live.is_sold !== 1 : true;
  const bidPrice = live?.bid_price !== undefined ? Number(live.bid_price) : null;

  async function handleSell() {
    setSelling(true);
    setError(null);
    try {
      await api.sell(position.contract_id, 0);
      onSold();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sell this contract");
    } finally {
      setSelling(false);
    }
  }

  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td style={{ padding: "10px 0" }}>
        <div style={{ fontSize: 13 }}>{live?.underlying_symbol ?? position.underlying_symbol}</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{live?.contract_type ?? position.contract_type}</div>
      </td>
      <td className="numeric">{Number(position.buy_price).toFixed(2)}</td>
      <td className="numeric">{bidPrice !== null ? bidPrice.toFixed(2) : "—"}</td>
      <td className="numeric" style={{ color: profit == null ? "var(--text-muted)" : profit >= 0 ? "var(--positive)" : "var(--negative)" }}>
        {profit == null ? "—" : `${profit >= 0 ? "+" : ""}${profit.toFixed(2)}`}
      </td>
      <td>
        {error && <div className="error-text" style={{ margin: 0 }}>{error}</div>}
        <button
          className="button"
          style={{ width: "auto", padding: "5px 12px", fontSize: 13, background: "transparent", border: "1px solid var(--border)", color: "var(--text)" }}
          onClick={handleSell}
          disabled={selling || !canSell}
        >
          {selling ? "Selling…" : canSell ? "Sell" : "Closed"}
        </button>
      </td>
    </tr>
  );
}

export function PortfolioPage() {
  const [positions, setPositions] = useState<PortfolioContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPositions(await api.portfolio());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your open positions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="card">
      <h1 style={{ marginTop: 0, fontSize: 18 }}>Portfolio</h1>
      {error && <div className="error-text">{error}</div>}

      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : positions.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          No open positions on this account. Head to Markets to place a trade.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12 }}>
              <th style={{ padding: "6px 0" }}>Contract</th>
              <th>Buy price</th>
              <th>Current price</th>
              <th>P/L</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <PositionRow key={p.contract_id} position={p} onSold={load} />
            ))}
          </tbody>
        </table>
      )}
      <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 16, marginBottom: 0 }}>
        Positions and prices come straight from Deriv in real time. Past or running P/L here is not a projection of future results.
      </p>
    </div>
  );
}
