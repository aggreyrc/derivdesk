import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { LoginPage } from "./routes/LoginPage";
import { AppShell } from "./routes/AppShell";
import { RequireAuth } from "./routes/RequireAuth";
import { BotsPage } from "./routes/BotsPage";
import { OverviewPage, UsersPage, ConnectionsPage, WithdrawalsPage, AuditLogPage, FeatureFlagsPage } from "./routes/pages";

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/withdrawals" element={<WithdrawalsPage />} />
            <Route path="/bots" element={<BotsPage />} />
            <Route path="/audit-log" element={<AuditLogPage />} />
            <Route path="/feature-flags" element={<FeatureFlagsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
