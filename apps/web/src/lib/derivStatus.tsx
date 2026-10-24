import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { DerivConnectionState } from "@derivdesk/shared-types";
import { api } from "./api";
import { useAuth } from "./auth";

// Lightweight polling for now — the active-account badge in the shell (visible on every
// page, not just /account) is what spec §5 means by "make the active environment
// unmistakable". Phase 4 replaces this with a pushed BALANCE_UPDATED/CONNECTION_CHANGED
// event over the WS gateway instead of polling.
const POLL_MS = 30_000;

const DerivStatusContext = createContext<DerivConnectionState | null>(null);

export function DerivStatusProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [state, setState] = useState<DerivConnectionState | null>(null);

  useEffect(() => {
    if (!user) {
      setState(null);
      return;
    }
    let cancelled = false;
    const poll = () => api.derivAccounts().then((s) => !cancelled && setState(s)).catch(() => {});
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [user]);

  return <DerivStatusContext.Provider value={state}>{children}</DerivStatusContext.Provider>;
}

/** Null until the first poll resolves, or if nothing is connected. */
export function useDerivStatus() {
  return useContext(DerivStatusContext);
}
