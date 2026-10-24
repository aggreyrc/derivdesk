// Empty string = same origin (production: the admin web server proxies /api to apps/admin-api).
const API_BASE_URL = import.meta.env.VITE_ADMIN_API_BASE_URL ?? "http://localhost:4100";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code ?? "UnknownError", body?.error?.message ?? "Request failed");
  }

  return (body?.data ?? body) as T;
}

export interface CurrentAdmin {
  id: string;
  email: string;
}

export interface AdminWithdrawalRow {
  id: string;
  userId: string;
  derivAccountId: string;
  agentId: string;
  amount: string;
  currency: string;
  requestId: string;
  status: "REQUESTED" | "PENDING" | "COMPLETE" | "REJECTED" | "FAILED";
  createdAt: string;
  updatedAt: string;
}

export type BotStrategyStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export interface BotStrategyRow {
  id: string;
  key: string;
  name: string;
  description: string;
  status: BotStrategyStatus;
  definition: unknown;
  createdAt: string;
  updatedAt: string;
}

export const api = {
  login: (email: string, password: string, totpCode?: string) =>
    request<CurrentAdmin>("/api/admin/auth/login", { method: "POST", body: JSON.stringify({ email, password, ...(totpCode ? { totpCode } : {}) }) }),
  logout: () => request<void>("/api/admin/auth/logout", { method: "POST" }),
  me: () => request<CurrentAdmin>("/api/admin/auth/me"),
  overview: () => request<{ connectedAccounts: number; pendingWithdrawals: number }>("/api/admin/overview"),
  listUsers: () => request<Array<{ id: string; handle: string; status: string; createdAt: string }>>("/api/admin/users"),
  listFeatureFlags: () => request<Array<{ key: string; enabled: boolean }>>("/api/admin/feature-flags"),
  listWithdrawals: (status?: string) =>
    request<AdminWithdrawalRow[]>(`/api/admin/withdrawals${status ? `?status=${encodeURIComponent(status)}` : ""}`),

  // Bot strategy CATALOG only — admin never sees a user's bot instances, accounts, or trades.
  listBotStrategies: () => request<BotStrategyRow[]>("/api/admin/bot-strategies"),
  createBotStrategy: (body: { key: string; name: string; description: string; definition: unknown }) =>
    request<BotStrategyRow>("/api/admin/bot-strategies", { method: "POST", body: JSON.stringify(body) }),
  updateBotStrategy: (id: string, body: { name?: string; description?: string; definition?: unknown }) =>
    request<BotStrategyRow>(`/api/admin/bot-strategies/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  setBotStrategyStatus: (id: string, status: BotStrategyStatus) =>
    request<BotStrategyRow>(`/api/admin/bot-strategies/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
  deleteBotStrategy: (id: string) => request<void>(`/api/admin/bot-strategies/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
