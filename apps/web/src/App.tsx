import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { DerivStatusProvider } from "./lib/derivStatus";
import { LoginPage } from "./routes/LoginPage";
import { AppShell } from "./routes/AppShell";
import { RequireAuth } from "./routes/RequireAuth";
import { AccountPage } from "./routes/AccountPage";
import { MarketsPage } from "./routes/MarketsPage";
import { PortfolioPage } from "./routes/PortfolioPage";
import { TransactionsPage } from "./routes/TransactionsPage";
import { AnalysisPage } from "./routes/AnalysisPage";
import { BotsPage } from "./routes/BotsPage";
import { PaymentsPage } from "./routes/PaymentsPage";
import {
  DashboardPage,
  SettingsPage,
} from "./routes/pages";

export function App() {
  return (
    <AuthProvider>
      <DerivStatusProvider>
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
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/markets" element={<MarketsPage />} />
            <Route path="/portfolio" element={<PortfolioPage />} />
            <Route path="/analysis" element={<AnalysisPage />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            <Route path="/bots" element={<BotsPage />} />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
      </DerivStatusProvider>
    </AuthProvider>
  );
}
