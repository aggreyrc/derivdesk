import { useEffect, useState } from "react";
import { marketSocket, type LiveBalance } from "./marketSocket";

/** Live balance for whichever Deriv account the session has active, or null until the
 *  first push arrives (or if nothing is connected/active). The server decides which
 *  account this is — this hook never takes an account id as a parameter. */
export function useBalance(): LiveBalance | null {
  const [balance, setBalance] = useState<LiveBalance | null>(null);

  useEffect(() => {
    return marketSocket.onBalance(setBalance);
  }, []);

  return balance;
}
