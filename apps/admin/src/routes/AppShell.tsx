import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";

const NAV_ITEMS = [
  { to: "/overview", label: "Overview" },
  { to: "/users", label: "Users" },
  { to: "/connections", label: "Connections" },
  { to: "/withdrawals", label: "Withdrawals" },
  { to: "/bots", label: "Bot strategies" },
  { to: "/audit-log", label: "Audit log" },
  { to: "/feature-flags", label: "Feature flags" },
];

export function AppShell() {
  const { admin, logout } = useAuth();

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="app-shell__brand">DerivDesk</div>
        <div className="app-shell__brand-tag">Operations console</div>
        <nav className="app-shell__nav">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : undefined)}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ marginTop: 28, fontSize: 12, color: "var(--text-muted)" }}>
          {admin?.email}
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
