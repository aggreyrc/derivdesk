import { useEffect, useState } from "react";
import type { OpenContract } from "@derivdesk/shared-types";
import { marketSocket } from "./marketSocket";

/** Live updates for one open contract (P/L, spot, sold/expired status), or null until the
 *  first push arrives. Subscribes on mount, unsubscribes on unmount/contractId change. */
export function usePosition(contractId: number | null): OpenContract | null {
  const [contract, setContract] = useState<OpenContract | null>(null);

  useEffect(() => {
    setContract(null);
    if (contractId == null) return;
    return marketSocket.subscribePosition(contractId, setContract);
  }, [contractId]);

  return contract;
}
