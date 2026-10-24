import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useDerivStatus } from "../lib/derivStatus";
import { useBalance } from "../lib/useBalance";

const NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/markets", label: "Markets" },
  { to: "/portfolio", label: "Portfolio" },
  { to: "/analysis", label: "Analysis" },
  { to: "/transactions", label: "Transactions" },
  { to: "/bots", label: "Bots" },
  { to: "/payments", label: "Payments" },
  { to: "/account", label: "Account" },
  { to: "/settings", label: "Settings" },
];

export function AppShell() {
  const { user, logout } = useAuth();
  const derivStatus = useDerivStatus();
  const active = derivStatus?.accounts.find((a) => a.isActive);
  const liveBalance = useBalance();

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="app-shell__brand">DerivDesk</div>
        {active && (
          <div style={{ marginBottom: 16 }}>
            <span className={`badge badge--${active.accountType.toLowerCase()}`}>
              {active.accountType === "REAL" ? "REAL ACCOUNT" : "Demo"} · {active.derivAccountId}
            </span>
            <div className="numeric" style={{ fontSize: 15, fontWeight: 600, marginTop: 8 }}>
              {liveBalance ? `${liveBalance.balance.toFixed(2)} ${liveBalance.currency}` : active.cachedBalance ? `${Number(active.cachedBalance).toFixed(2)} ${active.currency}` : "—"}
            </div>
          </div>
        )}
        <nav className="app-shell__nav">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : undefined)}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ marginTop: 32, fontSize: 13, color: "var(--text-muted)" }}>
          {user?.handle}
          <div>
            <button
              className="button"
              style={{ marginTop: 10, background: "transparent", border: "1px solid var(--border)", color: "var(--text)" }}
              onClick={() => logout()}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="app-shell__main">
        <Outlet />
      </main>
    </div>
  );
}
