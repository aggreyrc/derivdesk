import { useEffect, useState } from "react";
import { marketSocket, type MarketTick } from "./marketSocket";

/** Latest live tick for a symbol, or null until the first one arrives. Subscribes on mount,
 *  unsubscribes on unmount/symbol change — component lifetime IS subscription lifetime. */
export function useMarketTick(symbol: string | null): MarketTick | null {
  const [tick, setTick] = useState<MarketTick | null>(null);

  useEffect(() => {
    setTick(null);
    if (!symbol) return;
    return marketSocket.subscribe(symbol, setTick);
  }, [symbol]);

  return tick;
}
