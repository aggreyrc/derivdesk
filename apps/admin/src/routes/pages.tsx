import { useEffect, useState } from "react";
import { api, type AdminWithdrawalRow } from "../lib/api";

function Card({ children }: { children: React.ReactNode }) {
  return <div className="card">{children}</div>;
}

export function OverviewPage() {
  const [data, setData] = useState<{ connectedAccounts: number; pendingWithdrawals: number } | null>(null);

  useEffect(() => {
    api.overview().then(setData).catch(() => setData(null));
  }, []);

  return (
    <Card>
      <h1 style={{ marginTop: 0, fontSize: 17 }}>Overview</h1>
      {!data ? (
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : (
        <div style={{ display: "flex", gap: 32 }}>
          <div>
            <div className="mono" style={{ fontSize: 24 }}>
              {data.connectedAccounts}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Connected Deriv accounts</div>
          </div>
          <div>
            <div className="mono" style={{ fontSize: 24 }}>
              {data.pendingWithdrawals}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Pending withdrawals</div>
          </div>
        </div>
      )}
      <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 16 }}>
        Active WS connections and API error rate populate once apps/api exposes them (Phase 4 / Phase 8).
      </p>
    </Card>
  );
}

export function UsersPage() {
  const [users, setUsers] = useState<Array<{ id: string; handle: string; status: string; createdAt: string }>>([]);

  useEffect(() => {
    api.listUsers().then(setUsers).catch(() => setUsers([]));
  }, []);

  return (
    <Card>
      <h1 style={{ marginTop: 0, fontSize: 17 }}>Users</h1>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
            <th style={{ padding: "6px 0" }}>Deriv account</th>
            <th>Status</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} style={{ borderTop: "1px solid var(--border)" }}>
              <td className="mono" style={{ padding: "6px 0" }}>{u.handle}</td>
              <td>
                <span className={`status-dot status-dot--${u.status === "ACTIVE" ? "ok" : "bad"}`} />
                {u.status}
              </td>
              <td className="mono">{new Date(u.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 12 }}>
        Users sign in with Deriv only, so a user is identified by their Deriv account id. Suspend/reactivate acts only on this app-level status — never on the person's Deriv account.
      </p>
    </Card>
  );
}

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <Card>
      <h1 style={{ marginTop: 0, fontSize: 17 }}>{title}</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13 }}>{note}</p>
    </Card>
  );
}

export function ConnectionsPage() {
  return (
    <Placeholder
      title="Connections"
      note="Per-user Deriv connection health (last sync, token expiry, reconnect state) — same list+table pattern as Users, backed by GET /api/admin/connections. Token values are never returned by that endpoint."
    />
  );
}

const WITHDRAWAL_STATUSES = ["REQUESTED", "PENDING", "COMPLETE", "REJECTED", "FAILED"] as const;

function withdrawalStatusColor(status: string): string {
  switch (status) {
    case "COMPLETE":
      return "var(--positive, #3dd68c)";
    case "REJECTED":
    case "FAILED":
      return "var(--negative, #f2545b)";
    default:
      return "var(--text-muted)";
  }
}

export function WithdrawalsPage() {
  const [withdrawals, setWithdrawals] = useState<AdminWithdrawalRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .listWithdrawals(statusFilter || undefined)
      .then(setWithdrawals)
      .catch(() => setWithdrawals([]))
      .finally(() => setLoading(false));
  }, [statusFilter]);

  return (
    <Card>
      <h1 style={{ marginTop: 0, fontSize: 17 }}>Withdrawals</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: -4, marginBottom: 16 }}>
        Read-only payment-agent withdrawal triage. No action here can initiate, approve, or cancel a withdrawal — that only ever happens
        directly between the client and Deriv.
      </p>

      <div style={{ marginBottom: 14 }}>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", color: "var(--text)", fontSize: 13 }}
        >
          <option value="">All statuses</option>
          {WITHDRAWAL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : withdrawals.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No withdrawal requests{statusFilter ? ` with status ${statusFilter}` : ""}.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
              <th style={{ padding: "6px 0" }}>Requested</th>
              <th>User</th>
              <th>Agent</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Request ID</th>
            </tr>
          </thead>
          <tbody>
            {withdrawals.map((w) => (
              <tr key={w.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td className="mono" style={{ padding: "6px 0" }}>{new Date(w.createdAt).toLocaleString()}</td>
                <td className="mono">{w.userId}</td>
                <td className="mono">{w.agentId}</td>
                <td className="mono">
                  {w.amount} {w.currency}
                </td>
                <td style={{ color: withdrawalStatusColor(w.status) }}>{w.status}</td>
                <td className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {w.requestId}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function AuditLogPage() {
  return <Placeholder title="Audit log" note="Searchable audit_logs, backed by GET /api/admin/audit-log." />;
}

export function FeatureFlagsPage() {
  const [flags, setFlags] = useState<Array<{ key: string; enabled: boolean }>>([]);

  useEffect(() => {
    api.listFeatureFlags().then(setFlags).catch(() => setFlags([]));
  }, []);

  return (
    <Card>
      <h1 style={{ marginTop: 0, fontSize: 17 }}>Feature flags</h1>
      {flags.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No flags defined yet — add one with a PATCH to /api/admin/feature-flags/:key.</p>
      ) : (
        <ul>
          {flags.map((f) => (
            <li key={f.key} className="mono">
              {f.key}: {f.enabled ? "on" : "off"}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
